import { describe, expect, it, vi } from "vitest";
import type { FlashcastrFlash, FlashcastrUser } from "@flashcastr/shared-types";
import type { FlashcastrFlashesDb, FlashcastrUsersDb } from "@flashcastr/database";
import type { CastGateway } from "../src/castGateway.js";
import type { PromoteGateway } from "../src/promoteGateway.js";
import { FlashCaster, type ImageTierStore } from "../src/flashCaster.js";

const SIGNER_ENCRYPTION_KEY = "test-key";

function buildPayload(overrides: Partial<Parameters<FlashCaster["handle"]>[0]> = {}) {
  return {
    flash_id: 1,
    img: "img.png",
    city: "Paris",
    text: "text",
    player: "alice",
    timestamp: 1700000000,
    flash_count: "1",
    ipfs_cid: "cid123",
    ipfs_url: "ipfs://cid123",
    db_flash_id: 1,
    stored_at: 1700000001,
    image_tier: null,
    ...overrides,
  };
}

function buildUser(overrides: Partial<FlashcastrUser> = {}): FlashcastrUser {
  return {
    fid: 42,
    username: "alice",
    signer_uuid: "encrypted-signer",
    auto_cast: true,
    ...overrides,
  };
}

function buildGateway(overrides: Partial<CastGateway> = {}): CastGateway {
  return {
    fetchUser: vi.fn(async () => ({ pfpUrl: "pfp.png", username: "alice" })),
    publishCast: vi.fn(async () => ({ hash: "0xcast" })),
    lookupSigner: vi.fn(async () => ({ status: "approved" })),
    ...overrides,
  };
}

function buildUsersDb(overrides: Partial<FlashcastrUsersDb> = {}) {
  return {
    getByUsername: vi.fn(async () => null),
    getAll: vi.fn(async () => []),
    updateAutoCast: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as FlashcastrUsersDb;
}

function buildFlashesDb(overrides: Partial<FlashcastrFlashesDb> = {}) {
  return {
    getByFlashIds: vi.fn(async () => [] as FlashcastrFlash[]),
    insertMany: vi.fn(async () => []),
    updateCastHash: vi.fn(async () => undefined),
    getFailedCastsForRetry: vi.fn(async () => []),
    ...overrides,
  } as unknown as FlashcastrFlashesDb;
}

function buildPromoteGateway(overrides: Partial<PromoteGateway> = {}): PromoteGateway {
  return {
    promoteFeedToKeep: vi.fn(async () => undefined),
    ...overrides,
  };
}

function buildImageTierStore(overrides: Partial<ImageTierStore> = {}): ImageTierStore {
  return {
    markKept: vi.fn(async () => undefined),
    ...overrides,
  };
}

function buildFlashCaster(overrides: {
  users?: FlashcastrUsersDb;
  flashes?: FlashcastrFlashesDb;
  gateway?: CastGateway;
  decrypt?: (encryptedData: string, key: string) => string;
  promoteGateway?: PromoteGateway;
  imageTier?: ImageTierStore;
} = {}) {
  return new FlashCaster({
    users: overrides.users ?? buildUsersDb(),
    flashes: overrides.flashes ?? buildFlashesDb(),
    gateway: overrides.gateway ?? buildGateway(),
    decrypt: overrides.decrypt ?? ((data) => data),
    signerEncryptionKey: SIGNER_ENCRYPTION_KEY,
    promoteGateway: overrides.promoteGateway ?? buildPromoteGateway(),
    imageTier: overrides.imageTier ?? buildImageTierStore(),
  });
}

describe("FlashCaster.handle", () => {
  it("returns null and skips recording when the player is not a registered flashcastr user", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => null) });
    const flashCaster = buildFlashCaster({ users, flashes });

    const result = await flashCaster.handle(buildPayload());

    expect(result).toBeNull();
    expect(flashes.insertMany).not.toHaveBeenCalled();
  });

  it("returns null and does not re-publish when the flash was already cast", async () => {
    const flashes = buildFlashesDb({
      getByFlashIds: vi.fn(async () => [
        { flash_id: 1, user_fid: 42, user_username: "alice", user_pfp_url: "pfp.png", cast_hash: "0xexisting" },
      ]),
    });
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser()) });
    const flashCaster = buildFlashCaster({ users, flashes });

    const result = await flashCaster.handle(buildPayload());

    expect(result).toBeNull();
    expect(flashes.insertMany).not.toHaveBeenCalled();
  });

  it("records the flash with a null cast hash and publishes when auto_cast is off", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: false })) });
    const gateway = buildGateway();
    const flashCaster = buildFlashCaster({ users, flashes, gateway });

    const result = await flashCaster.handle(buildPayload());

    expect(flashes.insertMany).toHaveBeenCalledWith([
      { flash_id: 1, user_fid: 42, user_username: "alice", user_pfp_url: "pfp.png", cast_hash: null },
    ]);
    expect(gateway.publishCast).not.toHaveBeenCalled();
    expect(result).toMatchObject({ flash_id: 1, cast_hash: null, user_fid: 42, user_username: "alice", auto_cast: false });
  });

  it("computes ipfs_url and db_flash_id from a minimal CastableFlash-shaped row (job worker path)", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: false })) });
    const gateway = buildGateway();
    const flashCaster = buildFlashCaster({ users, flashes, gateway });

    const minimalFlash = {
      flash_id: 7,
      city: "Paris",
      player: "alice",
      img: "img.png",
      ipfs_cid: "cid456",
      text: "text",
      timestamp: 1700000000,
      flash_count: "1",
      image_tier: null,
    };

    const result = await flashCaster.handle(minimalFlash);

    expect(result).toMatchObject({
      ipfs_url: "https://gateway.pinata.cloud/ipfs/cid456",
      db_flash_id: 7,
    });
    expect(typeof result?.stored_at).toBe("number");
  });

  it("skips entirely when auto_cast is on but the flash has no IPFS CID", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway();
    const flashCaster = buildFlashCaster({ users, flashes, gateway });

    const result = await flashCaster.handle(buildPayload({ ipfs_cid: "" }));

    expect(result).toBeNull();
    expect(flashes.insertMany).not.toHaveBeenCalled();
    expect(gateway.publishCast).not.toHaveBeenCalled();
  });

  it("records a null cast hash and still publishes FLASH_CASTED when the cast publish fails", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway({ publishCast: vi.fn(async () => { throw new Error("Neynar down"); }) });
    const flashCaster = buildFlashCaster({ users, flashes, gateway });

    const result = await flashCaster.handle(buildPayload());

    expect(flashes.insertMany).toHaveBeenCalledWith([
      { flash_id: 1, user_fid: 42, user_username: "alice", user_pfp_url: "pfp.png", cast_hash: null },
    ]);
    expect(result).toMatchObject({ cast_hash: null, auto_cast: true });
  });

  it("claims the row before attempting to publish the cast", async () => {
    const flashes = buildFlashesDb({
      insertMany: vi.fn(async () => {
        throw new Error("DB blip");
      }),
    });
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway();
    const flashCaster = buildFlashCaster({ users, flashes, gateway });

    await expect(flashCaster.handle(buildPayload())).rejects.toThrow("DB blip");

    expect(gateway.publishCast).not.toHaveBeenCalled();
  });

  it("attempts publishCast again on redelivery when the cast hash was never persisted", async () => {
    const flashes = buildFlashesDb({
      updateCastHash: vi.fn(async () => {
        throw new Error("DB blip");
      }),
    });
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway();
    const flashCaster = buildFlashCaster({ users, flashes, gateway });

    await expect(flashCaster.handle(buildPayload())).rejects.toThrow("DB blip");

    flashes.getByFlashIds = vi.fn(async () => [
      { flash_id: 1, user_fid: 42, user_username: "alice", user_pfp_url: "pfp.png", cast_hash: null },
    ]);

    await expect(flashCaster.handle(buildPayload())).rejects.toThrow("DB blip");

    expect(gateway.publishCast).toHaveBeenCalledTimes(2);
    expect(gateway.publishCast).toHaveBeenNthCalledWith(1, "encrypted-signer", 1, "Paris");
    expect(gateway.publishCast).toHaveBeenNthCalledWith(2, "encrypted-signer", 1, "Paris");
  });

  it("promotes a feed-tier image to keep before publishing", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway();
    const promoteGateway = buildPromoteGateway();
    const imageTier = buildImageTierStore();
    const flashCaster = buildFlashCaster({ users, flashes, gateway, promoteGateway, imageTier });

    await flashCaster.handle(buildPayload({ image_tier: "feed" }));

    expect(promoteGateway.promoteFeedToKeep).toHaveBeenCalledWith(1, "cid123");
    expect(imageTier.markKept).toHaveBeenCalledWith(1);

    const promoteOrder = (promoteGateway.promoteFeedToKeep as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const publishOrder = (gateway.publishCast as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(promoteOrder).toBeLessThan(publishOrder);
  });

  it("skips promotion for an already-kept image and still publishes", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway();
    const promoteGateway = buildPromoteGateway();
    const flashCaster = buildFlashCaster({ users, flashes, gateway, promoteGateway });

    await flashCaster.handle(buildPayload({ image_tier: "keep" }));

    expect(promoteGateway.promoteFeedToKeep).not.toHaveBeenCalled();
    expect(gateway.publishCast).toHaveBeenCalled();
  });

  it("skips promotion when image_tier is null (pre-flag-flip / stay dark) and still publishes", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway();
    const promoteGateway = buildPromoteGateway();
    const flashCaster = buildFlashCaster({ users, flashes, gateway, promoteGateway });

    const result = await flashCaster.handle(buildPayload({ image_tier: null }));

    expect(promoteGateway.promoteFeedToKeep).not.toHaveBeenCalled();
    expect(gateway.publishCast).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });

  it("a promotion failure prevents the cast and propagates as a retryable error", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: true })) });
    const gateway = buildGateway();
    const promoteGateway = buildPromoteGateway({
      promoteFeedToKeep: vi.fn(async () => {
        throw new Error("b2 down");
      }),
    });
    const flashCaster = buildFlashCaster({ users, flashes, gateway, promoteGateway });

    await expect(flashCaster.handle(buildPayload({ image_tier: "feed" }))).rejects.toThrow("b2 down");

    expect(gateway.publishCast).not.toHaveBeenCalled();
  });

  it("promotes a feed-tier image to keep for an auto_cast-off user without publishing", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: false })) });
    const gateway = buildGateway();
    const promoteGateway = buildPromoteGateway();
    const imageTier = buildImageTierStore();
    const flashCaster = buildFlashCaster({ users, flashes, gateway, promoteGateway, imageTier });

    await flashCaster.handle(buildPayload({ image_tier: "feed" }));

    expect(promoteGateway.promoteFeedToKeep).toHaveBeenCalledWith(1, "cid123");
    expect(imageTier.markKept).toHaveBeenCalledWith(1);
    expect(gateway.publishCast).not.toHaveBeenCalled();
  });

  it("a promotion failure for an auto_cast-off user still propagates as a retryable error", async () => {
    const flashes = buildFlashesDb();
    const users = buildUsersDb({ getByUsername: vi.fn(async () => buildUser({ auto_cast: false })) });
    const gateway = buildGateway();
    const promoteGateway = buildPromoteGateway({
      promoteFeedToKeep: vi.fn(async () => {
        throw new Error("b2 down");
      }),
    });
    const flashCaster = buildFlashCaster({ users, flashes, gateway, promoteGateway });

    await expect(flashCaster.handle(buildPayload({ image_tier: "feed" }))).rejects.toThrow("b2 down");

    expect(gateway.publishCast).not.toHaveBeenCalled();
  });
});

describe("FlashCaster.retryFailedCasts", () => {
  function buildFailedCast(overrides: Partial<import("@flashcastr/database").FailedCastRow> = {}) {
    return {
      flash_id: 1,
      user_fid: 42,
      user_username: "alice",
      user_pfp_url: "pfp.png",
      signer_uuid: "encrypted-signer",
      auto_cast: true,
      player: "alice",
      city: "Paris",
      ipfs_cid: "cid123",
      timestamp: 1700000000,
      ...overrides,
    };
  }

  it("disables auto_cast when the retry publish fails because the signer was revoked", async () => {
    const users = buildUsersDb();
    const flashes = buildFlashesDb({
      getFailedCastsForRetry: vi.fn(async () => [buildFailedCast()]),
    });
    const gateway = buildGateway({
      publishCast: vi.fn(async () => { throw new Error("403 Forbidden: signer revoked"); }),
    });
    const flashCaster = buildFlashCaster({ users, flashes, gateway });

    await flashCaster.retryFailedCasts();

    expect(users.updateAutoCast).toHaveBeenCalledWith(42, false);
    expect(flashes.updateCastHash).not.toHaveBeenCalled();
  });
});
