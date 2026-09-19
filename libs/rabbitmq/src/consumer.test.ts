import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsumeMessage } from "amqplib";
import { Registry } from "prom-client";

const amqp = vi.hoisted(() => {
  const channel = {
    assertExchange: vi.fn(async () => ({})),
    assertQueue: vi.fn(async (name: string) => (name === "" ? { queue: "amq.gen-test" } : {})),
    bindQueue: vi.fn(async () => ({})),
    prefetch: vi.fn(async () => ({})),
    checkQueue: vi.fn(async (queue: string) => ({ queue, messageCount: queue === "flashcastr.dead-letters" ? 3 : 7, consumerCount: 1 })),
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

import { FlashcastrConsumer, FatalMessageError, TransientError } from "./index.js";
import type { MessageEnvelope } from "@flashcastr/shared-types";

type Payload = { n: number };
type Delivered = (msg: ConsumeMessage | null) => void;

let deliver: Delivered;

class TestConsumer extends FlashcastrConsumer<Payload> {
  handler = vi.fn<(envelope: MessageEnvelope<Payload>, raw: ConsumeMessage) => Promise<void>>(async () => undefined);
  retryable = true;

  constructor(options: { manualAck?: boolean; maxAttempts?: number; registry?: Registry } = {}) {
    super("test", "test.queue", {
      rabbitUrl: "amqp://test",
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 40,
      ...options,
    });
  }

  protected handleMessage(envelope: MessageEnvelope<Payload>, raw: ConsumeMessage): Promise<void> {
    return this.handler(envelope, raw);
  }

  protected override shouldRequeueOnFailure(): boolean {
    return this.retryable;
  }

  ackNow(raw: ConsumeMessage): void {
    this.ack(raw);
  }
}

class ExclusiveTestConsumer extends FlashcastrConsumer<Payload> {
  handler = vi.fn<(envelope: MessageEnvelope<Payload>, raw: ConsumeMessage) => Promise<void>>(async () => undefined);

  constructor() {
    super("test", "test.queue", {
      rabbitUrl: "amqp://test",
      exclusive: { bindings: ["flash.stored", "flash.casted"] },
    });
  }

  protected handleMessage(envelope: MessageEnvelope<Payload>, raw: ConsumeMessage): Promise<void> {
    return this.handler(envelope, raw);
  }
}

function message(body: unknown, messageId = "m1"): ConsumeMessage {
  const content = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    content,
    fields: { deliveryTag: 1, redelivered: false, exchange: "x", routingKey: "k", consumerTag: "t" },
    properties: { messageId } as ConsumeMessage["properties"],
  } as ConsumeMessage;
}

function envelope(n: number, id = "m1"): MessageEnvelope<Payload> {
  return { id, timestamp: 0, source: "test", type: "flash.received", version: "1.0", correlationId: "c", payload: { n } };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function start(consumer: TestConsumer | ExclusiveTestConsumer): Promise<void> {
  amqp.channel.consume.mockImplementation(async (_queue: string, onMessage: Delivered) => {
    deliver = onMessage;
    return { consumerTag: "tag-1" };
  });
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

describe("FlashcastrConsumer", () => {
  it("acks after a successful handler and reports it is consuming", async () => {
    const consumer = new TestConsumer();
    await start(consumer);
    expect(consumer.isConsuming()).toBe(true);

    const raw = message(envelope(1));
    deliver(raw);
    await settle();

    expect(consumer.handler).toHaveBeenCalledWith(envelope(1), raw);
    expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
    expect(amqp.channel.nack).not.toHaveBeenCalled();
  });

  it("dead-letters malformed JSON and non-envelope messages without calling the handler", async () => {
    const consumer = new TestConsumer();
    await start(consumer);

    const bad = message("{not json");
    const notEnvelope = message({ hello: "world" });
    deliver(bad);
    deliver(notEnvelope);
    await settle();

    expect(consumer.handler).not.toHaveBeenCalled();
    expect(amqp.channel.nack).toHaveBeenCalledWith(bad, false, false);
    expect(amqp.channel.nack).toHaveBeenCalledWith(notEnvelope, false, false);
  });

  it("requeues retryable failures with backoff, then dead-letters at maxAttempts", async () => {
    const consumer = new TestConsumer();
    consumer.handler.mockRejectedValue(new Error("flaky"));
    await start(consumer);

    const first = message(envelope(1));
    deliver(first);
    await settle();
    expect(amqp.channel.nack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(amqp.channel.nack).toHaveBeenLastCalledWith(first, false, true);

    const second = message(envelope(1));
    deliver(second);
    await vi.advanceTimersByTimeAsync(20);
    expect(amqp.channel.nack).toHaveBeenLastCalledWith(second, false, true);

    const third = message(envelope(1));
    deliver(third);
    await settle();
    expect(amqp.channel.nack).toHaveBeenLastCalledWith(third, false, false);
    expect(amqp.channel.nack).toHaveBeenCalledTimes(3);
  });

  it("dead-letters immediately when the failure is not retryable", async () => {
    const consumer = new TestConsumer();
    consumer.retryable = false;
    consumer.handler.mockRejectedValue(new Error("nope"));
    await start(consumer);

    const raw = message(envelope(1));
    deliver(raw);
    await settle();
    expect(amqp.channel.nack).toHaveBeenCalledWith(raw, false, false);
  });

  it("dead-letters FatalMessageError even when the policy would retry", async () => {
    const consumer = new TestConsumer();
    consumer.handler.mockRejectedValue(new FatalMessageError("poison"));
    await start(consumer);

    const raw = message(envelope(1));
    deliver(raw);
    await settle();
    expect(amqp.channel.nack).toHaveBeenCalledWith(raw, false, false);
  });

  it("requeues TransientError after its delay without consuming attempts", async () => {
    const consumer = new TestConsumer({ maxAttempts: 2 });
    consumer.handler.mockRejectedValue(new TransientError("circuit open", 50));
    await start(consumer);

    for (let i = 0; i < 5; i++) {
      const raw = message(envelope(1));
      deliver(raw);
      await settle();
      expect(amqp.channel.nack).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(50);
      expect(amqp.channel.nack).toHaveBeenLastCalledWith(raw, false, true);
    }
  });

  it("does not ack in manualAck mode until the handler acks", async () => {
    const consumer = new TestConsumer({ manualAck: true });
    await start(consumer);

    const raw = message(envelope(1));
    deliver(raw);
    await settle();
    expect(amqp.channel.ack).not.toHaveBeenCalled();

    consumer.ackNow(raw);
    expect(amqp.channel.ack).toHaveBeenCalledWith(raw);
  });

  it("skips settling a message whose delivery channel is gone", async () => {
    const consumer = new TestConsumer({ manualAck: true });
    await start(consumer);

    const raw = message(envelope(1));
    deliver(raw);
    await settle();

    await consumer.close();
    expect(consumer.isConsuming()).toBe(false);
    consumer.ackNow(raw);
    expect(amqp.channel.ack).not.toHaveBeenCalled();
  });

  it("reconnects when the broker cancels the consumer", async () => {
    const consumer = new TestConsumer();
    await start(consumer);
    expect(amqp.connect).toHaveBeenCalledTimes(1);

    deliver(null);
    expect(consumer.isConsuming()).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);

    expect(amqp.connect).toHaveBeenCalledTimes(2);
    expect(consumer.isConsuming()).toBe(true);
    await consumer.close();
  });

  it("reports queue depths for its queue and the dead-letter queue", async () => {
    const consumer = new TestConsumer();
    await start(consumer);
    await expect(consumer.queueDepths()).resolves.toEqual({ queue: 7, deadLetters: 3 });
  });

  it("connects to a server-named exclusive queue and binds it when exclusive option is set", async () => {
    const consumer = new ExclusiveTestConsumer();
    await start(consumer);

    expect(amqp.channel.assertQueue).toHaveBeenCalledWith("", { exclusive: true, autoDelete: true });
    expect(amqp.channel.bindQueue).toHaveBeenCalledWith("amq.gen-test", "flashcastr.events", "flash.stored");
    expect(amqp.channel.bindQueue).toHaveBeenCalledWith("amq.gen-test", "flashcastr.events", "flash.casted");
    expect(amqp.channel.consume).toHaveBeenCalledWith("amq.gen-test", expect.any(Function), { noAck: false });
    expect(consumer.queueName).toBe("amq.gen-test");
  });

  it("records a processed metric on ack when a registry is provided", async () => {
    const registry = new Registry();
    const consumer = new TestConsumer({ registry });
    await start(consumer);

    const raw = message(envelope(1));
    deliver(raw);
    await settle();

    const json = await registry.getMetricsAsJSON();
    const processed = json.find((entry) => entry.name === "flashcastr_consumer_messages_processed_total") as
      | { values: { labels: Record<string, string>; value: number }[] }
      | undefined;
    expect(processed?.values.find((v) => v.labels.service === "test")?.value).toBe(1);
  });

  it("records dead-lettered and requeued metrics for their respective outcomes", async () => {
    const registry = new Registry();
    const consumer = new TestConsumer({ registry, maxAttempts: 2 });
    consumer.handler.mockRejectedValue(new Error("flaky"));
    await start(consumer);

    const first = message(envelope(1));
    deliver(first);
    await settle();
    await vi.advanceTimersByTimeAsync(10);

    const second = message(envelope(1));
    deliver(second);
    await settle();

    const json = await registry.getMetricsAsJSON();
    const metric = (name: string) =>
      (json.find((entry) => entry.name === name) as { values: { labels: Record<string, string>; value: number }[] } | undefined)
        ?.values.find((v) => v.labels.service === "test")?.value;

    expect(metric("flashcastr_consumer_messages_requeued_total")).toBe(1);
    expect(metric("flashcastr_consumer_messages_deadlettered_total")).toBe(1);
  });

  it("does not attach metrics when no registry is provided", async () => {
    const consumer = new TestConsumer();
    await start(consumer);

    const raw = message(envelope(1));
    expect(() => {
      deliver(raw);
    }).not.toThrow();
  });
});
