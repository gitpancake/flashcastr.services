import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const amqp = vi.hoisted(() => {
  const channel = {
    assertExchange: vi.fn(async () => ({})),
    assertQueue: vi.fn(async (name: string) => (name === "" ? { queue: "amq.gen-subscriptions" } : {})),
    bindQueue: vi.fn(async () => ({})),
    prefetch: vi.fn(async () => ({})),
    checkQueue: vi.fn(async (queue: string) => ({ queue, messageCount: 0, consumerCount: 1 })),
    consume: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const connection = {
    createChannel: vi.fn(async () => channel),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { channel, connection, connect: vi.fn(async () => connection) };
});

vi.mock("amqplib", () => ({ connect: amqp.connect }));

import { SubscriptionConsumer } from "./subscription-consumer.js";
import { InMemoryPubSub } from "./pubsub.js";

async function start(consumer: SubscriptionConsumer): Promise<void> {
  amqp.channel.consume.mockImplementation(async () => ({ consumerTag: "tag-1" }));
  await consumer.startConsuming();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const fn of Object.values(amqp.channel)) fn.mockClear();
  for (const fn of Object.values(amqp.connection)) fn.mockClear();
  amqp.connect.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SubscriptionConsumer", () => {
  it("binds a server-named exclusive queue to flash.stored and flash.casted instead of a durable api.subscriptions queue", async () => {
    const consumer = new SubscriptionConsumer("amqp://test", new InMemoryPubSub());
    await start(consumer);

    expect(amqp.channel.assertQueue).toHaveBeenCalledWith("", { exclusive: true, autoDelete: true });
    expect(amqp.channel.assertQueue).not.toHaveBeenCalledWith("api.subscriptions", expect.anything());
    expect(amqp.channel.bindQueue).toHaveBeenCalledWith("amq.gen-subscriptions", "flashcastr.events", "flash.stored");
    expect(amqp.channel.bindQueue).toHaveBeenCalledWith("amq.gen-subscriptions", "flashcastr.events", "flash.casted");
    expect(consumer.queueName).toBe("amq.gen-subscriptions");
  });
});
