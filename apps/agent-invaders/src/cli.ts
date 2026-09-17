import { assembleApplication } from "./application.js";
import { loadEnv } from "./config/env.js";
import { parseInvaderId, type InvaderId } from "./invaders/invaderId.js";
import { describeStatus } from "./invaders/invaderStatus.js";
import { InvaderSpotterClient } from "./invaders/invaderSpotterClient.js";
import { InvaderSpotterSession } from "./invaders/invaderSpotterSession.js";
import { createLogger } from "./logging/logger.js";
import { previewDigest, previewReply } from "./preview.js";

async function runDigest(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const app = await assembleApplication(env, logger);
  await app.digestCommand.execute();
  await app.shutdown();
}

async function runStatus(rawIds: string[]): Promise<void> {
  const ids = rawIds.map(parseInvaderId).filter((id): id is InvaderId => id !== null);
  if (ids.length === 0) throw new Error("usage: status PA_04 LDN_01 ...");
  const spotter = new InvaderSpotterClient(new InvaderSpotterSession());
  for (const status of await spotter.lookupStatuses(ids)) console.log(describeStatus(status));
}

async function runNews(): Promise<void> {
  const spotter = new InvaderSpotterClient(new InvaderSpotterSession());
  for (const event of (await spotter.fetchNewsEvents()).slice(0, 30)) console.log(`${event.date} ${event.kind} ${event.displayId}`);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  digest: runDigest,
  preview: () => previewDigest(rest[0] ?? new Date().toISOString().slice(0, 10)),
  reply: () => previewReply(rest.join(" ") || "how's PA_04 doing?"),
  status: () => runStatus(rest),
  news: runNews,
};
const selected = command ? commands[command] : undefined;
if (!selected) {
  console.error(`usage: cli <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
selected().catch((error) => {
  console.error(error);
  process.exit(1);
});
