import { z } from "zod";

const settings = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).max(60000).default(5000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  RESEND_API_KEY: z.string().regex(/^\S+$/).optional(),
  ENQUIRY_FROM: z.email().optional(),
  ENQUIRY_TO: z.email().optional()
}).superRefine((env, ctx) => {
  const mail = [env.RESEND_API_KEY, env.ENQUIRY_FROM, env.ENQUIRY_TO];
  if (mail.some(Boolean) && !mail.every(Boolean)) {
    ctx.addIssue({ code: "custom", message: "Configure all three enquiry email settings or none." });
  }
});

export function readConfig(env: NodeJS.ProcessEnv) {
  const result = settings.safeParse(env);
  if (!result.success) {
    throw new Error("Invalid environment: " + result.error.issues.map(i => i.path.join(".") || i.message).join(", "));
  }
  return result.data;
}

export type Config = ReturnType<typeof readConfig>;
