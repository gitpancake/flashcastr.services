/**
 * One-off migration script: drains messages from the old `invader-flashes` queue,
 * wraps them in MessageEnvelope<FlashReceivedPayload>, and republishes to
 * `flash-engine.flash-received` for the new pipeline to process.
 *
 * Usage: npx tsx scripts/migrate-old-queue.ts
 *
 * Requires RABBITMQ_URL in .env or environment.
 */
import { config } from "dotenv";
config();

import { connect } from "amqplib";
import { randomUUID } from "crypto";
import type { MessageEnvelope, FlashReceivedPayload } from "@flashcastr/shared-types";
import { EXCHANGES, ROUTING_KEYS } from "@flashcastr/rabbitmq";

const OLD_QUEUE = "invader-flashes";
const BATCH_LOG_INTERVAL = 100;

async function main() {
  const rabbitUrl = process.env.RABBITMQ_URL;
  if (!rabbitUrl) throw new Error("RABBITMQ_URL is required");

  console.log("Connecting to RabbitMQ...");
  const connection = await connect(rabbitUrl);
  const channel = await connection.createChannel();

  // Ensure old queue exists (don't create if it doesn't)
  const queueInfo = await channel.checkQueue(OLD_QUEUE);
  console.log(`Found ${queueInfo.messageCount} messages in ${OLD_QUEUE}`);

  if (queueInfo.messageCount === 0) {
    console.log("Nothing to migrate.");
    await channel.close();
    await connection.close();
    return;
  }

  // Ensure new exchange exists
  await channel.assertExchange(EXCHANGES.EVENTS, "topic", { durable: true });

  let migrated = 0;
  let failed = 0;

  // Consume one at a time
  await channel.prefetch(1);

  return new Promise<void>((resolve) => {
    channel.consume(
      OLD_QUEUE,
      async (msg) => {
        if (!msg) return;

        try {
          const oldFlash = JSON.parse(msg.content.toString());

          const payload: FlashReceivedPayload = {
            flash_id: oldFlash.flash_id,
            img: oldFlash.img,
            city: oldFlash.city || "",
            text: oldFlash.text || "",
            player: oldFlash.player || "",
            timestamp: oldFlash.timestamp || Date.now(),
            flash_count: oldFlash.flash_count || "0",
          };

          const envelope: MessageEnvelope<FlashReceivedPayload> = {
            id: randomUUID(),
            timestamp: Date.now(),
            source: "migrate-old-queue",
            type: ROUTING_KEYS.FLASH_RECEIVED,
            version: "1.0.0",
            correlationId: randomUUID(),
            payload,
          };

          channel.publish(
            EXCHANGES.EVENTS,
            ROUTING_KEYS.FLASH_RECEIVED,
            Buffer.from(JSON.stringify(envelope)),
            { persistent: true }
          );

          channel.ack(msg);
          migrated++;

          if (migrated % BATCH_LOG_INTERVAL === 0) {
            console.log(`Migrated ${migrated} messages...`);
          }
        } catch (err) {
          console.error("Failed to migrate message:", err);
          channel.nack(msg, false, false); // send to DLQ, don't requeue
          failed++;
        }

        // Check if we're done
        const remaining = await channel.checkQueue(OLD_QUEUE);
        if (remaining.messageCount === 0) {
          console.log(`\nMigration complete: ${migrated} migrated, ${failed} failed`);
          console.log(`\nTo delete the old queue, run:`);
          console.log(`  npx tsx scripts/migrate-old-queue.ts --delete`);
          await channel.close();
          await connection.close();
          resolve();
        }
      },
      { noAck: false }
    );
  });
}

// Handle --delete flag
if (process.argv.includes("--delete")) {
  (async () => {
    const rabbitUrl = process.env.RABBITMQ_URL;
    if (!rabbitUrl) throw new Error("RABBITMQ_URL is required");

    const connection = await connect(rabbitUrl);
    const channel = await connection.createChannel();

    const queueInfo = await channel.checkQueue(OLD_QUEUE);
    if (queueInfo.messageCount > 0) {
      console.log(`Queue still has ${queueInfo.messageCount} messages. Migrate first.`);
    } else {
      await channel.deleteQueue(OLD_QUEUE);
      console.log(`Deleted queue: ${OLD_QUEUE}`);
    }

    await channel.close();
    await connection.close();
  })();
} else {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
