import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Config } from "./config.ts";
import { ApiError, createServices, enquiry } from "./upstream.ts";

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map(i => i.path.join(".") || "request");
    throw new ApiError(400, `Invalid ${[...new Set(fields)].join(", ")}.`);
  }
  return result.data;
}

function limiter(limit: number) {
  return rateLimit({
    windowMs: 60_000, limit, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many requests. Try again later." }
  });
}

const empty = z.strictObject({});
const term = z.string().trim().min(1).max(100);
const id = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive());

export function createApp(config: Config, request: typeof fetch = fetch) {
  const app = express();
  const service = createServices(config, request);
  app.disable("x-powered-by");
  app.use(cors({
    origin: "*",
    methods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    exposedHeaders: ["Retry-After", "RateLimit", "RateLimit-Policy"],
    credentials: false
  }));
  if (config.TRUSTED_PROXY_IP) app.set("trust proxy", config.TRUSTED_PROXY_IP);
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", limiter(120));

  app.get("/api/categories", async (req, res) => {
    validate(empty, req.query);
    res.json(await service.categories());
  });
  app.get("/api/products", async (req, res) => {
    const { category } = validate(z.strictObject({ category: term.optional() }), req.query);
    const items = await service.products();
    res.json(category ? items.filter(p => p.category === category) : items);
  });
  app.get("/api/products/featured", async (req, res) => {
    validate(empty, req.query);
    const items = await service.products();
    res.json(items.sort((a, b) => b.rating.rate - a.rating.rate ||
      b.rating.count - a.rating.count || a.id - b.id).slice(0, 5));
  });
  app.get("/api/products/search", async (req, res) => {
    const { q } = validate(z.strictObject({ q: term }), req.query);
    const needle = q.toLowerCase();
    res.json((await service.products()).filter(p => p.title.toLowerCase().includes(needle)));
  });
  app.get("/api/products/:id", async (req, res) => {
    validate(empty, req.query);
    res.json(await service.detail(validate(id, req.params.id)));
  });
  app.post("/api/enquiries", limiter(5), express.json({ limit: "32kb" }), async (req, res) => {
    if (!req.is("application/json")) throw new ApiError(415, "Expected application/json.");
    validate(empty, req.query);
    const receipt = await service.send(validate(enquiry, req.body));
    res.status(202).json({ status: "accepted", id: receipt.id });
  });
  app.use((_req, res) => res.status(404).json({ error: "Route not found." }));
  const onError: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof Error && "status" in err && typeof err.status === "number" &&
        err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: "Invalid request encoding, size, or syntax." });
      return;
    }
    console.error("Unhandled API error", err instanceof Error ? err.name : "unknown");
    res.status(500).json({ error: "Internal server error." });
  };
  app.use(onError);
  return app;
}
