import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PublishCallback = (err: Error | null) => void;

const amqp = vi.hoisted(() => {
  const publishCallbacks: PublishCallback[] = [];
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const channel = {
    assertExchange: vi.fn(async () => ({})),
    assertQueue: vi.fn(async () => ({})),
    bindQueue: vi.fn(async () => ({})),
    publish: vi.fn((_ex: string, _key: string, _buf: Buffer, _opts: unknown, cb: PublishCallback) => {
      publishCallbacks.push(cb);
      return true;
    }),
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const connection = {
    createConfirmChannel: vi.fn(async () => channel),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    close: vi.fn(async () => undefined),
  };
  return { channel, connection, publishCallbacks, listeners, connect: vi.fn(async () => connection) };
});

vi.mock("amqplib", () => ({ connect: amqp.connect }));

import { FlashcastrPublisher } from "./publisher.js";
import { EXCHANGES } from "./topology.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  amqp.publishCallbacks.length = 0;
  for (const key of Object.keys(amqp.listeners)) delete amqp.listeners[key];
  amqp.connect.mockClear();
  amqp.channel.publish.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FlashcastrPublisher", () => {
  it("publishes a persistent envelope on a confirm channel and resolves on broker ack", async () => {
    const publisher = new FlashcastrPublisher("svc", { rabbitUrl: "amqp://test" });
    const pending = publisher.publish("flash.received", { flash_id: 1 }, "corr-1");
    await vi.advanceTimersByTimeAsync(0);

    expect(amqp.connection.createConfirmChannel).toHaveBeenCalled();
    const [exchange, routingKey, body, options] = amqp.channel.publish.mock.calls[0] as unknown as [string, string, Buffer, { persistent: boolean; messageId: string }];
    const envelope = JSON.parse(body.toString());
    expect(exchange).toBe(EXCHANGES.EVENTS);
    expect(routingKey).toBe("flash.received");
    expect(options.persistent).toBe(true);
    expect(options.messageId).toBe(envelope.id);
    expect(envelope).toMatchObject({ source: "svc", type: "flash.received", correlationId: "corr-1", payload: { flash_id: 1 } });

    amqp.publishCallbacks[0]!(null);
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects when the broker nacks the publish", async () => {
    const publisher = new FlashcastrPublisher("svc", { rabbitUrl: "amqp://test" });
    const pending = publisher.publish("flash.received", {});
    await vi.advanceTimersByTimeAsync(0);
    amqp.publishCallbacks[0]!(new Error("nacked"));
    await expect(pending).rejects.toThrow(/nacked/);
  });

  it("rejects when no confirm arrives within the timeout", async () => {
    const publisher = new FlashcastrPublisher("svc", { rabbitUrl: "amqp://test", confirmTimeoutMs: 100 });
    const pending = publisher.publish("flash.received", {});
    const outcome = pending.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toBeInstanceOf(Error);
    await expect(outcome).resolves.toMatchObject({ message: expect.stringContaining("not confirmed") });
  });

  it("shares a single connection across concurrent publishes", async () => {
    const publisher = new FlashcastrPublisher("svc", { rabbitUrl: "amqp://test" });
    const a = publisher.publish("a", {});
    const b = publisher.publish("b", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(amqp.connect).toHaveBeenCalledTimes(1);
    amqp.publishCallbacks.forEach((cb) => cb(null));
    await Promise.all([a, b]);
  });

  it("reconnects lazily after the connection closes", async () => {
    const publisher = new FlashcastrPublisher("svc", { rabbitUrl: "amqp://test" });
    const first = publisher.publish("a", {});
    await vi.advanceTimersByTimeAsync(0);
    amqp.publishCallbacks[0]!(null);
    await first;
    expect(publisher.isConnected()).toBe(true);

    amqp.listeners["close"]?.forEach((handler) => handler());
    expect(publisher.isConnected()).toBe(false);

    const second = publisher.publish("b", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(amqp.connect).toHaveBeenCalledTimes(2);
    amqp.publishCallbacks[1]!(null);
    await second;
  });
});
