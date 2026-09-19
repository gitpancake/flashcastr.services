import { describe, expect, it, vi } from "vitest";
import { ImageEngineConsumer } from "../src/imageEngineConsumer.js";
import type { ImagePinner } from "../src/imagePinner.js";

class TestableImageEngineConsumer extends ImageEngineConsumer {
  requeueOnFailure(error: Error): boolean {
    return this.shouldRequeueOnFailure(error);
  }
}

function buildConsumer(): TestableImageEngineConsumer {
  const imagePinner = { handle: vi.fn() } as unknown as ImagePinner;
  return new TestableImageEngineConsumer(imagePinner, { rabbitUrl: "amqp://fake" });
}

describe("ImageEngineConsumer.shouldRequeueOnFailure", () => {
  it("does not requeue duplicate or already-processed errors", () => {
    const consumer = buildConsumer();
    expect(consumer.requeueOnFailure(new Error("duplicate flash"))).toBe(false);
    expect(consumer.requeueOnFailure(new Error("Already processed"))).toBe(false);
  });

  it("requeues any other error", () => {
    const consumer = buildConsumer();
    expect(consumer.requeueOnFailure(new Error("network blip"))).toBe(true);
  });
});
