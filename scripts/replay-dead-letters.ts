/**
 * Replays messages from `flashcastr.dead-letters` back onto their original
 * routing key so the owning engine reprocesses them.
 *
 * Usage:
 *   npx tsx scripts/replay-dead-letters.ts [--limit N] [--only <routing-key>] [--dry-run]
 *
 * The DLX routing key is `<original>.dead`; the original key is recovered by
 * stripping that suffix. x-death headers are dropped so the replay starts fresh.
 * Requires RABBITMQ_URL in .env or the environment.
 */
import { config } from "dotenv";
config();

import { connect, type ConsumeMessage } from "amqplib";
import { EXCHANGES, QUEUES } from "@flashcastr/rabbitmq";

const DEAD_SUFFIX = ".dead";
const IDLE_TIMEOUT_MS = 3000;

interface Options {
  limit: number;
  only: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: Number.MAX_SAFE_INTEGER, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") options.limit = parseInt(argv[++i] ?? "", 10);
    else if (arg === "--only") options.only = argv[++i] ?? null;
    else if (arg === "--dry-run") options.dryRun = true;
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) throw new Error("--limit must be a positive integer");
  return options;
}

function originalRoutingKey(msg: ConsumeMessage): string {
  const key = msg.fields.routingKey;
  return key.endsWith(DEAD_SUFFIX) ? key.slice(0, -DEAD_SUFFIX.length) : key;
}

function stripDeathHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const { "x-death": _death, "x-first-death-exchange": _ex, "x-first-death-queue": _q, "x-first-death-reason": _r, ...rest } = headers ?? {};
  return rest;
}

async function main(): Promise<void> {
  const rabbitUrl = process.env.RABBITMQ_URL;
  if (!rabbitUrl) throw new Error("RABBITMQ_URL is not defined");
  const options = parseArgs(process.argv.slice(2));

  const connection = await connect(rabbitUrl);
  const channel = await connection.createConfirmChannel();
  await channel.prefetch(50);

  const depth = await channel.checkQueue(QUEUES.DEAD_LETTERS);
  console.log(`${QUEUES.DEAD_LETTERS}: ${depth.messageCount} message(s) waiting${options.dryRun ? " (dry run)" : ""}`);

  let replayed = 0;
  let skipped = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(finish, IDLE_TIMEOUT_MS);
  };
  touch();

  const consumer = await channel.consume(QUEUES.DEAD_LETTERS, (msg) => {
    if (!msg) return;
    touch();

    const routingKey = originalRoutingKey(msg);
    const shouldReplay = replayed < options.limit && (!options.only || options.only === routingKey);
    if (!shouldReplay) {
      skipped++;
      channel.nack(msg, false, true);
      if (replayed >= options.limit) finish();
      return;
    }

    if (options.dryRun) {
      replayed++;
      console.log(`[dry-run] would replay ${msg.properties.messageId ?? "?"} -> ${routingKey}`);
      channel.nack(msg, false, true);
      if (replayed >= options.limit) finish();
      return;
    }

    channel.publish(
      EXCHANGES.EVENTS,
      routingKey,
      msg.content,
      { ...msg.properties, headers: stripDeathHeaders(msg.properties.headers as Record<string, unknown> | undefined) },
      (err) => {
        if (err) {
          console.error(`Replay of ${msg.properties.messageId ?? "?"} failed: ${err.message}`);
          channel.nack(msg, false, true);
          return;
        }
        channel.ack(msg);
        replayed++;
        if (replayed % 100 === 0) console.log(`Replayed ${replayed}...`);
        if (replayed >= options.limit) finish();
      }
    );
  });

  await done;
  await channel.cancel(consumer.consumerTag);
  await channel.waitForConfirms();
  console.log(`Done: ${replayed} replayed, ${skipped} left in place`);
  await channel.close();
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
