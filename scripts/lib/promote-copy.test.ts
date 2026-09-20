import { describe, expect, it } from "vitest";
import {
  copyCandidateToKeepTier,
  type CopyDestination,
  type CopySource,
  type FetchedImage,
} from "./promote-copy.js";

class FakeDestination implements CopyDestination {
  objects = new Map<string, Buffer>();
  corruptOnGet: Set<string> = new Set();

  async putObject(key: string, data: Buffer, _contentType: string): Promise<void> {
    this.objects.set(key, data);
  }

  async getObject(key: string): Promise<Buffer> {
    if (this.corruptOnGet.has(key)) {
      return Buffer.from("corrupted-bytes");
    }
    const data = this.objects.get(key);
    if (!data) throw new Error(`not found: ${key}`);
    return data;
  }
}

describe("copyCandidateToKeepTier", () => {
  it("copies a feed-tier candidate from fetchFeedBytes to keep/<ipfs_cid> and verifies", async () => {
    const feedBytes = Buffer.from("feed image bytes");
    const source: CopySource = {
      fetchFeedBytes: async (hash: string): Promise<FetchedImage> => {
        expect(hash).toBe("sha256hash123");
        return { data: feedBytes, contentType: "image/png" };
      },
      fetchPinataBytes: async () => {
        throw new Error("should not be called for feed tier");
      },
    };
    const destination = new FakeDestination();

    const outcome = await copyCandidateToKeepTier(
      { flash_id: 1, ipfs_cid: "sha256hash123", image_tier: "feed" },
      source,
      destination
    );

    expect(outcome).toEqual({ flashId: 1, key: "keep/sha256hash123", verified: true });
    expect(destination.objects.get("keep/sha256hash123")).toEqual(feedBytes);
  });

  it("copies a legacy candidate (image_tier null) from fetchPinataBytes to keep/<ipfs_cid>", async () => {
    const legacyBytes = Buffer.from("legacy pinata bytes");
    const source: CopySource = {
      fetchFeedBytes: async () => {
        throw new Error("should not be called for legacy tier");
      },
      fetchPinataBytes: async (cid: string): Promise<FetchedImage> => {
        expect(cid).toBe("QmLegacyOpaqueCid");
        return { data: legacyBytes, contentType: "image/jpeg" };
      },
    };
    const destination = new FakeDestination();

    const outcome = await copyCandidateToKeepTier(
      { flash_id: 2, ipfs_cid: "QmLegacyOpaqueCid", image_tier: null },
      source,
      destination
    );

    expect(outcome).toEqual({ flashId: 2, key: "keep/QmLegacyOpaqueCid", verified: true });
    expect(destination.objects.get("keep/QmLegacyOpaqueCid")).toEqual(legacyBytes);
  });

  it("reports verified:false without throwing when the destination read-back is corrupted", async () => {
    const source: CopySource = {
      fetchFeedBytes: async () => ({ data: Buffer.from("original bytes"), contentType: "image/png" }),
      fetchPinataBytes: async () => {
        throw new Error("should not be called for feed tier");
      },
    };
    const destination = new FakeDestination();
    destination.corruptOnGet.add("keep/corrupt-cid");

    const outcome = await copyCandidateToKeepTier(
      { flash_id: 3, ipfs_cid: "corrupt-cid", image_tier: "feed" },
      source,
      destination
    );

    expect(outcome).toEqual({ flashId: 3, key: "keep/corrupt-cid", verified: false });
  });

  it("propagates an error thrown by source.fetchFeedBytes instead of swallowing it", async () => {
    const source: CopySource = {
      fetchFeedBytes: async () => {
        throw new Error("network timeout");
      },
      fetchPinataBytes: async () => {
        throw new Error("should not be called for feed tier");
      },
    };
    const destination = new FakeDestination();

    await expect(
      copyCandidateToKeepTier(
        { flash_id: 4, ipfs_cid: "any-cid", image_tier: "feed" },
        source,
        destination
      )
    ).rejects.toThrow("network timeout");
  });
});
