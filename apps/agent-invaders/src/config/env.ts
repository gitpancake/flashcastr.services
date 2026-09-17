import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  FIREWORKS_API_KEY: z.string().min(1),
  FIREWORKS_MODEL: z.string().default("accounts/fireworks/models/glm-5p3"),
  FIREWORKS_BASE_URL: z.string().url().default("https://api.fireworks.ai/inference/v1"),
  NEYNAR_API_KEY: z.string().min(1),
  NEYNAR_WEBHOOK_SECRET: z.string().optional(),
  HUB_HTTP_URL: z.string().url().default("https://hub-api.neynar.com"),
  FARCASTER_FID: z.coerce.number().int().positive(),
  FARCASTER_SIGNER_PRIVATE_KEY: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
  FARCASTER_CHANNEL_ID: z.string().default("invaders"),
  PORT: z.coerce.number().int().default(8080),
  DAILY_DIGEST_CRON: z.string().default("0 9 * * *"),
  MENTION_POLL_INTERVAL_MS: z.coerce.number().int().default(5 * 60 * 1000),
  ADMIN_TOKEN: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  EXTRA_RSS_FEEDS: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new Error(`Invalid environment:\n${problems.join("\n")}`);
}
