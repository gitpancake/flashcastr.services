import amqplib from 'amqplib';
import { getRequiredEnv } from '../config/index.js';
import { EXCHANGE_NAME } from '../events/index.js';

let connection: Awaited<ReturnType<typeof amqplib.connect>> | null = null;
let channel: Awaited<ReturnType<Awaited<ReturnType<typeof amqplib.connect>>['createConfirmChannel']>> | null = null;
let intentionalClose = false;
let reconnecting = false;
/**
 * Explicit liveness flag for health checks. A non-null `channel` reference is
 * not enough — during reconnect a stale handle can linger briefly after the
 * underlying connection fires 'close'. We flip this true ONLY after a
 * successful connect + channel setup, and false inside every close/error
 * handler BEFORE any reconnect scheduling.
 */
let connected = false;

const MAX_RECONNECT_ATTEMPTS = 10;

const reconnectCallbacks: Array<(ch: Awaited<ReturnType<typeof connectRabbitMQ>>) => Promise<void>> = [];

export type { ConfirmChannel } from 'amqplib';

/** Register a callback invoked with the new channel after reconnection. */
export function onReconnect(cb: (ch: Awaited<ReturnType<typeof connectRabbitMQ>>) => Promise<void>): void {
  reconnectCallbacks.push(cb);
}

async function reconnectWithBackoff(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  connected = false;
  channel = null;
  connection = null;

  try {
    let delay = 1000;
    const maxDelay = 30000;
    let attempts = 0;

    while (!intentionalClose && attempts < MAX_RECONNECT_ATTEMPTS) {
      attempts++;
      console.log(`RabbitMQ reconnecting in ${delay / 1000}s (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      await new Promise((r) => setTimeout(r, delay));
      try {
        const ch = await connectRabbitMQ();
        console.log('RabbitMQ reconnected');
        for (const cb of reconnectCallbacks) {
          await cb(ch);
        }
        return;
      } catch (err) {
        console.error('RabbitMQ reconnect failed:', err);
        delay = Math.min(delay * 2, maxDelay);
      }
    }

    if (!intentionalClose) {
      console.error(`RabbitMQ reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts — exiting for restart`);
      process.exit(1);
    }
  } finally {
    reconnecting = false;
  }
}

export async function connectRabbitMQ() {
  if (channel) return channel;
  if (reconnecting) {
    throw new Error('RabbitMQ reconnection in progress');
  }

  const url = getRequiredEnv('RABBITMQ_URL');
  connection = await amqplib.connect(url, { heartbeat: 30 });
  channel = await connection.createConfirmChannel();

  await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

  await channel.assertExchange('life.dlx', 'fanout', { durable: true });
  await channel.assertQueue('life.dlq', { durable: true });
  await channel.bindQueue('life.dlq', 'life.dlx', '');

  connection.on('close', () => {
    connected = false;
    channel = null;
    connection = null;
    if (!intentionalClose) {
      console.warn('RabbitMQ connection closed unexpectedly, starting reconnect...');
      reconnectWithBackoff();
    }
  });

  connection.on('error', (err) => {
    connected = false;
    console.error('RabbitMQ connection error:', err);
  });

  channel.on('close', () => {
    connected = false;
  });

  channel.on('error', (err) => {
    connected = false;
    console.error('RabbitMQ channel error:', err);
  });

  // Mark connected only after all setup succeeded.
  connected = true;

  return channel;
}

/** True if the shared connection currently has a live channel. Used by health checks. */
export function isRabbitMQConnected(): boolean {
  return connected;
}

export async function disconnectRabbitMQ(): Promise<void> {
  intentionalClose = true;
  connected = false;
  if (channel) await channel.close();
  if (connection) await connection.close();
  channel = null;
  connection = null;
}
