import { assembleApplication, verifySigner } from "./application.js";
import { loadEnv } from "./config/env.js";
import { startHttpServer } from "./inbound/httpServer.js";
import { createLogger } from "./logging/logger.js";
import { DailyScheduler } from "./scheduling/dailyScheduler.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const app = await assembleApplication(env, logger);
  await verifySigner(env, app.hubGateway, logger);

  const scheduler = new DailyScheduler(env.DAILY_DIGEST_CRON, app.digestCommand, logger);
  scheduler.start();
  app.poller.start();
  const server = startHttpServer({
    port: env.PORT,
    webhookSecret: env.NEYNAR_WEBHOOK_SECRET,
    adminToken: env.ADMIN_TOKEN,
    dispatcher: app.dispatcher,
    digestCommand: app.digestCommand,
    logger,
  });

  const stop = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    scheduler.stop();
    server.close();
    await app.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
