import { describe, expect, it } from "vitest";
import { InMemoryPubSub } from "./pubsub.js";

describe("InMemoryPubSub", () => {
  it("delivers a published payload to a subscriber", async () => {
    const pubsub = new InMemoryPubSub();
    const iterator = pubsub.subscribe("topic-a")[Symbol.asyncIterator]();

    const pending = iterator.next();
    pubsub.publish("topic-a", { hello: "world" });

    await expect(pending).resolves.toEqual({ value: { hello: "world" }, done: false });
  });

  it("keeps two instances independent, publishing on one never reaching the other", async () => {
    const pubsubA = new InMemoryPubSub();
    const pubsubB = new InMemoryPubSub();
    const iteratorB = pubsubB.subscribe("topic-a")[Symbol.asyncIterator]();

    pubsubA.publish("topic-a", "from-a");
    pubsubB.publish("topic-a", "from-b");

    await expect(iteratorB.next()).resolves.toEqual({ value: "from-b", done: false });
  });

  it("buffers events for a late subscriber and drops the oldest once the buffer fills", async () => {
    const pubsub = new InMemoryPubSub();
    const iterator = pubsub.subscribe("topic-a")[Symbol.asyncIterator]();

    for (let i = 0; i < 1001; i++) pubsub.publish("topic-a", i);

    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
  });

  it("stops delivery and removes the listener once the subscriber unsubscribes via return()", async () => {
    const pubsub = new InMemoryPubSub();
    const iterator = pubsub.subscribe("topic-a")[Symbol.asyncIterator]();

    await expect(iterator.return!(undefined)).resolves.toEqual({ value: undefined, done: true });

    pubsub.publish("topic-a", "after-unsubscribe");
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
