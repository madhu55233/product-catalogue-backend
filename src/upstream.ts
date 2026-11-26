import { z } from "zod";
import type { Config } from "./config.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const product = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  category: z.string().min(1),
  description: z.string(),
  price: z.number().nonnegative(),
  image: z.httpUrl(),
  rating: z.object({ rate: z.number().min(0).max(5), count: z.number().int().nonnegative() })
});

export const enquiry = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  message: z.string().trim().min(1).max(3000),
  productId: z.number().int().positive().optional()
});

const store = "https://fakestoreapi.com/products";

export function createServices(config: Config, request: typeof fetch = fetch) {
  async function json<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}, detail = false) {
    const signal = AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS);
    try {
      const response = await request(url, { ...init, redirect: "error", signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (detail && response.status === 404) throw new ApiError(404, "Product not found.");
        throw new ApiError(502, "Upstream service failed.");
      }
      const text = await response.text();
      if (detail && ["", "null"].includes(text.trim())) throw new ApiError(404, "Product not found.");
      return schema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (signal.aborted) throw new ApiError(504, "Upstream service timed out.");
      throw new ApiError(502, "Upstream service unavailable or returned invalid data.");
    }
  }

  return {
    categories: () => json(`${store}/categories`, z.array(z.string().min(1))),
    products: () => json(store, z.array(product)),
    async detail(id: number) {
      const item = await json(`${store}/${id}`, product, {}, true);
      if (item.id !== id) throw new ApiError(502, "Upstream returned the wrong product.");
      return item;
    },
    async send(input: z.infer<typeof enquiry>) {
      const { RESEND_API_KEY, ENQUIRY_FROM, ENQUIRY_TO } = config;
      if (!RESEND_API_KEY || !ENQUIRY_FROM || !ENQUIRY_TO) {
        throw new ApiError(503, "Enquiry email is not configured.");
      }
      return json("https://api.resend.com/emails", z.object({ id: z.uuid() }), {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: ENQUIRY_FROM, to: [ENQUIRY_TO], reply_to: input.email,
          subject: "Product catalogue enquiry",
          text: [
            `From: ${input.name} <${input.email}>`,
            ...(input.productId ? [`Product ID: ${input.productId}`] : []),
            "", input.message
          ].join("\n")
        })
      });
    }
  };
}
