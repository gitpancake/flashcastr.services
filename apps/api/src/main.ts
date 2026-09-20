import { startApi } from "./server.js";
import { createLogger } from "@flashcastr/logger";

const log = createLogger("api");

async function fail(message: string, err: unknown): Promise<void> {
  log.error(message, err);
  await log.flush();
  process.exit(1);
}

process.on("unhandledRejection", (reason) => void fail("Unhandled promise rejection:", reason));
process.on("uncaughtException", (err) => void fail("Uncaught exception:", err));

startApi().catch((err) => fail("Failed to start API:", err));
