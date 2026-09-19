import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "@flashcastr/resilience";
import { TransientError } from "@flashcastr/rabbitmq";
import type { FlashReceivedPayload } from "@flashcastr/shared-types";
import type { DownloadedImage, ImageSource } from "../src/imageSource.js";
import type { Pinner } from "../src/pinner.js";
import { ImagePinner, RabbitMqPinCompletionPort } from "../src/imagePinner.js";

const CORRELATION_ID = "corr-1";

function buildFlash(overrides: Partial<FlashReceivedPayload> = {}): FlashReceivedPayload {
  return {
    flash_id: 1,
    img: "/images/1.png",
    city: "Paris",
    text: "text",
    player: "alice",
    timestamp: 1700000000,
    flash_count: "1",
    ...overrides,
  };
}

function buildSource(overrides: Partial<ImageSource> = {}): ImageSource {
  return {
    download: vi.fn(async () => ({ data: new ArrayBuffer(0), contentType: "image/png" }) satisfies DownloadedImage),
    ...overrides,
  };
}

function buildPinner(overrides: Partial<Pinner> = {}): Pinner {
  return {
    pin: vi.fn(async () => "cid123"),
    ...overrides,
  };
}

function buildCompletionPort() {
  return { complete: vi.fn(async () => undefined) };
}

function buildRateLimiter() {
  return { wait: vi.fn(async () => undefined) };
}

function buildImagePinner(overrides: Partial<ConstructorParameters<typeof ImagePinner>[0]> = {}) {
  const source = overrides.source ?? buildSource();
  const pinner = overrides.pinner ?? buildPinner();
  const completionPort = overrides.completionPort ?? buildCompletionPort();
  const rateLimiter = overrides.rateLimiter ?? buildRateLimiter();
  const breaker =
    overrides.breaker ?? new CircuitBreaker({ failureThreshold: 5, openDurationMs: 300000 });

  return {
    source,
    pinner,
    completionPort,
    rateLimiter,
    breaker,
    imagePinner: new ImagePinner({
      source,
      pinner,
      completionPort,
      breaker,
      rateLimiter,
      baseUrl: "https://api.space-invaders.com",
      gatewayUrl: "https://gateway.pinata.cloud/ipfs",
      maxCircuitRetryWaitMs: 30000,
      logEveryNFlashes: 100,
      ...overrides,
    }),
  };
}

describe("ImagePinner", () => {
  it("throws TransientError with the breaker's wait when the circuit is open, before downloading or rate-limiting", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 300000 });
    await breaker.execute(() => Promise.reject(new Error("boom"))).catch(() => undefined);
    expect(breaker.state).toBe("open");

    const source = buildSource();
    const rateLimiter = buildRateLimiter();
    const { imagePinner } = buildImagePinner({ breaker, source, rateLimiter });

    const expectedWait = Math.min(Math.max(breaker.retryAfterMs(), 1000), 30000);
    await expect(imagePinner.handle(buildFlash(), CORRELATION_ID)).rejects.toBeInstanceOf(TransientError);
    await expect(imagePinner.handle(buildFlash(), CORRELATION_ID)).rejects.toMatchObject({
      retryAfterMs: expectedWait,
    });
    expect(source.download).not.toHaveBeenCalled();
    expect(rateLimiter.wait).not.toHaveBeenCalled();
  });

  it("counts a pin failure toward the breaker exactly once per message, even with an internally retrying pinner", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, openDurationMs: 300000 });
    const pinner = buildPinner({ pin: vi.fn(async () => { throw new Error("pin failed after retries"); }) });
    const { imagePinner } = buildImagePinner({ breaker, pinner });

    await expect(imagePinner.handle(buildFlash(), CORRELATION_ID)).rejects.toThrow("pin failed after retries");
    expect(breaker.failures).toBe(1);
    expect(pinner.pin).toHaveBeenCalledTimes(1);
  });

  it("completes the pin through the completion port and increments the ipfsUploads counter on success", async () => {
    const completionPort = buildCompletionPort();
    const ipfsUploads = { inc: vi.fn() };
    const flash = buildFlash({ flash_id: 5, img: "/images/5.png" });
    const { imagePinner } = buildImagePinner({ completionPort, ipfsUploads: ipfsUploads as never });

    await imagePinner.handle(flash, CORRELATION_ID);

    expect(completionPort.complete).toHaveBeenCalledWith(
      { ...flash, ipfs_cid: "cid123", ipfs_url: "https://gateway.pinata.cloud/ipfs/cid123" },
      CORRELATION_ID
    );
    expect(ipfsUploads.inc).toHaveBeenCalledTimes(1);
  });
});

describe("RabbitMqPinCompletionPort", () => {
  it("publishes to image.pinned with the given payload and correlation id", async () => {
    const publish = vi.fn(async () => undefined);
    const port = new RabbitMqPinCompletionPort({ publish });
    const payload = {
      ...buildFlash(),
      ipfs_cid: "cid123",
      ipfs_url: "https://gateway.pinata.cloud/ipfs/cid123",
    };

    await port.complete(payload, "corr-1");

    expect(publish).toHaveBeenCalledWith("image.pinned", payload, "corr-1");
  });
});
