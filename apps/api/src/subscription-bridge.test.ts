import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

const pg = vi.hoisted(() => {
  const instances: Array<{
    connect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    listeners: Record<string, Handler[]>;
  }> = [];

  class Client {
    connect = vi.fn(async () => undefined);
    query = vi.fn(async () => ({}));
    end = vi.fn(async () => undefined);
    listeners: Record<string, Handler[]> = {};
    on = vi.fn((event: string, handler: Handler) => {
      (this.listeners[event] ??= []).push(handler);
      return this;
    });

    constructor() {
      instances.push(this);
    }
  }

  return { Client, instances };
});

vi.mock("pg", () => ({ Client: pg.Client }));

import { PostgresSubscriptionBridge } from "./subscription-bridge.js";
import { InMemoryPubSub, TOPICS } from "./pubsub.js";
import { NOTIFY_CHANNELS } from "@flashcastr/database";

function latestClient() {
  return pg.instances[pg.instances.length - 1]!;
}

function emit(event: string, ...args: unknown[]): void {
  const client = latestClient();
  for (const handler of client.listeners[event] ?? []) handler(...args);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  pg.instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PostgresSubscriptionBridge", () => {
  it("connects and issues LISTEN for both channels on start", async () => {
    const bridge = new PostgresSubscriptionBridge("postgres://test", new InMemoryPubSub());
    await bridge.start();

    const client = latestClient();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(`LISTEN ${NOTIFY_CHANNELS.FLASH_STORED}`);
    expect(client.query).toHaveBeenCalledWith(`LISTEN ${NOTIFY_CHANNELS.FLASH_CASTED}`);
  });

  it("publishes a flash_stored notification to the FLASH_STORED topic with the parsed payload", async () => {
    const pubsub = new InMemoryPubSub();
    const publishSpy = vi.spyOn(pubsub, "publish");
    const bridge = new PostgresSubscriptionBridge("postgres://test", pubsub);
    await bridge.start();

    const payload = { flash_id: "1", city: "paris", player: "p", img: "i", ipfs_cid: "cid", timestamp: "t" };
    emit("notification", { channel: NOTIFY_CHANNELS.FLASH_STORED, payload: JSON.stringify(payload) });

    expect(publishSpy).toHaveBeenCalledWith(TOPICS.FLASH_STORED, payload);
  });

  it("publishes a flash_casted notification to the FLASH_CASTED topic with the parsed payload", async () => {
    const pubsub = new InMemoryPubSub();
    const publishSpy = vi.spyOn(pubsub, "publish");
    const bridge = new PostgresSubscriptionBridge("postgres://test", pubsub);
    await bridge.start();

    const payload = { flash_id: "1", city: "paris", player: "p", cast_hash: "h", user_fid: 1, user_username: "u" };
    emit("notification", { channel: NOTIFY_CHANNELS.FLASH_CASTED, payload: JSON.stringify(payload) });

    expect(publishSpy).toHaveBeenCalledWith(TOPICS.FLASH_CASTED, payload);
  });

  it("swallows malformed JSON payloads without publishing or throwing", async () => {
    const pubsub = new InMemoryPubSub();
    const publishSpy = vi.spyOn(pubsub, "publish");
    const bridge = new PostgresSubscriptionBridge("postgres://test", pubsub);
    await bridge.start();

    expect(() =>
      emit("notification", { channel: NOTIFY_CHANNELS.FLASH_STORED, payload: "{not json" })
    ).not.toThrow();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("reports isListening() true after a successful connect", async () => {
    const bridge = new PostgresSubscriptionBridge("postgres://test", new InMemoryPubSub());
    expect(bridge.isListening()).toBe(false);
    await bridge.start();
    expect(bridge.isListening()).toBe(true);
  });

  it("recovers from an 'end' event by reconnecting with backoff and re-issuing LISTEN", async () => {
    const bridge = new PostgresSubscriptionBridge("postgres://test", new InMemoryPubSub());
    await bridge.start();
    expect(bridge.isListening()).toBe(true);

    emit("end");
    expect(bridge.isListening()).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);

    expect(pg.instances).toHaveLength(2);
    const secondClient = latestClient();
    expect(secondClient.connect).toHaveBeenCalledTimes(1);
    expect(secondClient.query).toHaveBeenCalledWith(`LISTEN ${NOTIFY_CHANNELS.FLASH_STORED}`);
    expect(secondClient.query).toHaveBeenCalledWith(`LISTEN ${NOTIFY_CHANNELS.FLASH_CASTED}`);
    expect(bridge.isListening()).toBe(true);
  });

  it("does not reconnect when 'end' fires after close()", async () => {
    const bridge = new PostgresSubscriptionBridge("postgres://test", new InMemoryPubSub());
    await bridge.start();
    expect(pg.instances).toHaveLength(1);

    await bridge.close();
    emit("end");

    await vi.advanceTimersByTimeAsync(60000);

    expect(pg.instances).toHaveLength(1);
    expect(bridge.isListening()).toBe(false);
  });
});
