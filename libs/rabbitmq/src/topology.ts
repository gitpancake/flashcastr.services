import type { Channel } from "amqplib";

export const EXCHANGES = {
  EVENTS: "flashcastr.events",
  DLX: "flashcastr.dlx",
} as const;

export const ROUTING_KEYS = {
  FLASH_RECEIVED: "flash.received",
  IMAGE_PINNED: "image.pinned",
  FLASH_STORED: "flash.stored",
  FLASH_CASTED: "flash.casted",
} as const;

export const QUEUES = {
  FLASH_RECEIVED: "flash-engine.flash-received",
  IMAGE_PINNED: "image-engine.image-pinned",
  FLASH_STORED: "database-engine.flash-stored",
  FLASH_CASTED: "neynar-engine.flash-casted",
  API_SUBSCRIPTIONS: "api.subscriptions",
  DEAD_LETTERS: "flashcastr.dead-letters",
} as const;

const QUEUE_TO_ROUTING_KEY: Record<string, string> = {
  [QUEUES.FLASH_RECEIVED]: ROUTING_KEYS.FLASH_RECEIVED,
  [QUEUES.IMAGE_PINNED]: ROUTING_KEYS.IMAGE_PINNED,
  [QUEUES.FLASH_STORED]: ROUTING_KEYS.FLASH_STORED,
  [QUEUES.FLASH_CASTED]: ROUTING_KEYS.FLASH_CASTED,
};

export async function setupTopology(channel: Channel): Promise<void> {
  // Assert exchanges
  await channel.assertExchange(EXCHANGES.EVENTS, "topic", { durable: true });
  await channel.assertExchange(EXCHANGES.DLX, "topic", { durable: true });

  // Assert dead letter queue
  await channel.assertQueue(QUEUES.DEAD_LETTERS, { durable: true });
  await channel.bindQueue(QUEUES.DEAD_LETTERS, EXCHANGES.DLX, "*.dead");

  // Assert service queues with DLQ config
  for (const [queueName, routingKey] of Object.entries(QUEUE_TO_ROUTING_KEY)) {
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": EXCHANGES.DLX,
        "x-dead-letter-routing-key": `${routingKey}.dead`,
        "x-max-length": 100000,
      },
    });
    await channel.bindQueue(queueName, EXCHANGES.EVENTS, routingKey);
  }

  // API subscription queue — binds to multiple routing keys for live updates
  await channel.assertQueue(QUEUES.API_SUBSCRIPTIONS, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": EXCHANGES.DLX,
      "x-dead-letter-routing-key": "api.subscriptions.dead",
      "x-max-length": 10000,
    },
  });
  await channel.bindQueue(QUEUES.API_SUBSCRIPTIONS, EXCHANGES.EVENTS, ROUTING_KEYS.FLASH_STORED);
  await channel.bindQueue(QUEUES.API_SUBSCRIPTIONS, EXCHANGES.EVENTS, ROUTING_KEYS.FLASH_CASTED);
}
