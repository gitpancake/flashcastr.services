import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DownloadedImage } from "../src/imageSource.js";

const send = vi.fn(async (_command: unknown) => ({}) as unknown);

vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class S3Client {
    send(command: unknown): Promise<unknown> {
      return send(command);
    }
  }
  return { S3Client, PutObjectCommand };
});

const { B2Pinner } = await import("../src/b2Pinner.js");

function buildImage(bytes: number[], contentType = "image/png"): DownloadedImage {
  return { data: new Uint8Array(bytes).buffer, contentType };
}

function buildPinner() {
  return new B2Pinner({
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    bucket: "flashcastr-images",
    keyId: "key-id",
    applicationKey: "app-key",
  });
}

describe("B2Pinner", () => {
  it("returns the sha256 hex digest of the image bytes", async () => {
    const image = buildImage([1, 2, 3, 4]);
    const expectedHash = createHash("sha256").update(Buffer.from(image.data)).digest("hex");

    const hash = await buildPinner().pin(image, "photo.png");

    expect(hash).toBe(expectedHash);
  });

  it("PUTs to feed/<hash> in the configured bucket with the downloaded content type", async () => {
    send.mockClear();
    const image = buildImage([5, 6, 7], "image/jpeg");
    const expectedHash = createHash("sha256").update(Buffer.from(image.data)).digest("hex");

    await buildPinner().pin(image, "photo.jpg");

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toMatchObject({
      Bucket: "flashcastr-images",
      Key: `feed/${expectedHash}`,
      ContentType: "image/jpeg",
    });
  });

  it("retries a transient PutObject failure and eventually resolves", async () => {
    vi.useFakeTimers();
    try {
      send.mockClear();
      send.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce({});
      const image = buildImage([9, 9, 9]);

      const pinPromise = buildPinner().pin(image, "photo.png");
      await vi.runAllTimersAsync();
      const hash = await pinPromise;

      expect(send).toHaveBeenCalledTimes(2);
      expect(hash).toBe(createHash("sha256").update(Buffer.from(image.data)).digest("hex"));
    } finally {
      vi.useRealTimers();
    }
  });
});
