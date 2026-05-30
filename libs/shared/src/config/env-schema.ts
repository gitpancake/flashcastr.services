import { z } from 'zod';

// Base env vars all services need
export const baseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
});

// Shared fragments — composable building blocks for agent schemas

/** Google OAuth vars shared between agent-email and agent-calendar */
export const googleOAuthEnvSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REFRESH_TOKEN: z.string().min(1),
});

/** Pub/Sub vars shared between agent-email and agent-calendar (optional — falls back to polling if not set) */
export const pubsubOptionalEnvSchema = z.object({
  PUBSUB_PROJECT_ID: z.string().optional(),
  PUBSUB_SUBSCRIPTION: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),
});

/** Anthropic auth via Claude.ai subscription OAuth token. Required by every agent that runs AI calls. */
export const anthropicEnvSchema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
});

// Email agent specific
export const emailEnvSchema = baseEnvSchema
  .merge(googleOAuthEnvSchema)
  .merge(anthropicEnvSchema)
  .merge(pubsubOptionalEnvSchema)
  .extend({
    POLL_INTERVAL_MS: z.coerce.number().min(1000).default(60000),
    GMAIL_PUBSUB_TOPIC: z.string().optional(),
    FALLBACK_POLL_INTERVAL_MS: z.coerce.number().min(60000).default(300000),
  });

// Calendar agent
export const calendarEnvSchema = baseEnvSchema
  .merge(googleOAuthEnvSchema)
  .merge(pubsubOptionalEnvSchema)
  .extend({
    POLL_INTERVAL_MS: z.coerce.number().min(1000).default(60000),
    CALENDAR_WEBHOOK_URL: z.string().url().optional(),
    FALLBACK_POLL_INTERVAL_MS: z.coerce.number().min(60000).default(600000),
  });

// Weather agent (no extra env vars needed)
export const weatherEnvSchema = baseEnvSchema;

// Recipe agent
export const recipeEnvSchema = baseEnvSchema.merge(anthropicEnvSchema);

// Activity agent
export const activityEnvSchema = baseEnvSchema.merge(anthropicEnvSchema);

// Fi agent (pet tracking) — merges anthropic for refinement AI
export const fiEnvSchema = baseEnvSchema.merge(anthropicEnvSchema).extend({
  FI_EMAIL: z.string().email(),
  FI_PASSWORD: z.string().min(1),
  FI_PET_NAME: z.string().optional(),
});

// Football agent
export const footballEnvSchema = baseEnvSchema.extend({
  FOOTBALL_DATA_API_KEY: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().min(60000).default(900000), // 15 min
});

// API gateway
export const apiGatewayEnvSchema = baseEnvSchema.extend({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  FIREBASE_ALLOWED_UID: z.string().min(1),
  PORT: z.coerce.number().default(3000),
});

// RS3 agent (hiscores API is unauthenticated)
export const rs3EnvSchema = baseEnvSchema;

// Dev Blog agent (deprecated — use blogEnvSchema + paragraphEnvSchema)
export const devBlogEnvSchema = baseEnvSchema.merge(anthropicEnvSchema).extend({
  PARAGRAPH_API_KEY: z.string().min(1),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_UPLOAD_PRESET: z.string().min(1),
});

// Blog agent (scheduling + content generation)
export const blogEnvSchema = baseEnvSchema.merge(anthropicEnvSchema).extend({
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_UPLOAD_PRESET: z.string().min(1),
});

// Paragraph broadcast (publishing only)
// No DATABASE_URL — broadcast-paragraph is stateless (no Railway PG volume).
// Idempotency for nightly stats refresh is enforced downstream by agent-blog.
export const paragraphEnvSchema = z.object({
  RABBITMQ_URL: z.string().min(1),
  PARAGRAPH_API_KEY: z.string().min(1),
});

// Cast broadcast (submits directly to Neynar Hub, no managed signers — no "posted by" attribution)
export const castEnvSchema = baseEnvSchema.extend({
  NEYNAR_API_KEY: z.string().min(1),
  FARCASTER_ENCRYPTION_KEY: z.string().min(1),
  HUB_HTTP_URL: z.string().url().default('https://hub-api.neynar.com'),
});

// Farcaster agent
export const farcasterEnvSchema = baseEnvSchema.merge(anthropicEnvSchema).extend({
  NEYNAR_API_KEY: z.string().min(1),
  FARCASTER_ENCRYPTION_KEY: z.string().min(1),
  // Real-time inbound webhook (optional). Unset → silent fallback to the
  // 15-min poll. When set, agent-flashcastr hosts an HTTP receiver on
  // process.env.PORT and HMAC-SHA512-verifies the X-Neynar-Signature header.
  NEYNAR_WEBHOOK_SECRET: z.string().optional(),
  // Daily-prep optional inputs (HEN-584)
  AWAZLEON_USER: z.string().optional(),
  AWAZLEON_PASS: z.string().optional(),
  FLASHCASTR_API_URL: z.string().url().optional(),
});

// Notification service (just base)
export const notificationServiceEnvSchema = baseEnvSchema;

// Git Agent
export const gitEnvSchema = baseEnvSchema.merge(anthropicEnvSchema).extend({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_USERNAME: z.string().min(1),
});

// Research agent
export const researchEnvSchema = baseEnvSchema.merge(anthropicEnvSchema);

export function validateEnv<T extends z.ZodObject<z.ZodRawShape>>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error('Environment validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
