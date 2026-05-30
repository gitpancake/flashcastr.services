import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { LifeEvent } from '../events/index.js';
import { EXCHANGE_NAME } from '../events/index.js';

const MAX_RETRIES = 3;

// These PG codes indicate structural schema mismatches that will never self-resolve.
// Retrying is pointless — crash so Railway restarts after a DB re-provision.
const SCHEMA_ERROR_CODES = new Set(['42P01', '42703']); // relation/column does not exist

function isSchemaError(error: unknown): boolean {
  // postgres-js spreads PG wire-protocol fields directly onto PostgresError, so
  // .code lives on the error itself. DrizzleQueryError (other adapters) nests the
  // original error in .cause — check both.
  const directCode = (error as any)?.code;
  if (typeof directCode === 'string' && SCHEMA_ERROR_CODES.has(directCode)) return true;
  const causeCode = (error as any)?.cause?.code;
  return typeof causeCode === 'string' && SCHEMA_ERROR_CODES.has(causeCode);
}

// Anthropic OAuth window throttles (5h / 24h) outlast any in-handler backoff.
// AIClient throws RateLimitExhaustedError after its own retry budget; retrying
// at the subscriber layer just pounds the same throttled bucket and burns the
// same handler 3 more times. DLQ direct — next scheduled tick will pick it up
// once the bucket has refilled.
function isRateLimitExhausted(error: unknown): boolean {
  return (error as { name?: string })?.name === 'RateLimitExhaustedError';
}

export interface SubscriberOptions {
  queueName: string;
  patterns: string[];
  handler: (event: LifeEvent) => Promise<void>;
  prefetch?: number;
}

export async function createSubscriber(
  channel: ConfirmChannel,
  options: SubscriberOptions
): Promise<void> {
  const { queueName, patterns, handler, prefetch = 10 } = options;

  channel.prefetch(prefetch);

  await channel.assertQueue(queueName, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'life.dlx',
    },
  });

  for (const pattern of patterns) {
    await channel.bindQueue(queueName, EXCHANGE_NAME, pattern);
  }

  await channel.consume(queueName, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    try {
      const event: LifeEvent = JSON.parse(msg.content.toString());
      await handler(event);
      channel.ack(msg);
    } catch (error) {
      if (isSchemaError(error)) {
        console.error('[schema-error] Missing table/column detected — schema mismatch, crashing process', error);
        process.exit(1);
      }

      if (isRateLimitExhausted(error)) {
        console.error(`Message ${msg.properties.messageId} hit exhausted AI rate-limit — DLQ direct, next scheduled tick will retry`, error);
        channel.nack(msg, false, false);
        return;
      }

      const retryCount = (msg.properties.headers?.['x-retry-count'] ?? 0) as number;

      if (retryCount >= MAX_RETRIES) {
        console.error(`Message ${msg.properties.messageId} exceeded max retries, sending to DLQ`, error);
        channel.nack(msg, false, false);
      } else {
        console.warn(`Message ${msg.properties.messageId} failed (retry ${retryCount + 1}/${MAX_RETRIES})`, error);
        channel.ack(msg);
        channel.sendToQueue(
          queueName,
          msg.content,
          {
            ...msg.properties,
            headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 },
          }
        );
        await channel.waitForConfirms();
      }
    }
  });
}
