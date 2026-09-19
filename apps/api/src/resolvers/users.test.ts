import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookupSigner: vi.fn(),
  finalizeSignupProcess: vi.fn(),
  decrypt: vi.fn(() => "decrypted-signer-uuid"),
  getByFid: vi.fn(),
}));

vi.mock("@flashcastr/database", () => ({
  FlashcastrUsersDb: vi.fn().mockImplementation(function () {
    return {
      getByFid: mocks.getByFid,
      listPublic: vi.fn(),
      updateAutoCast: vi.fn(),
      deleteWithFlashes: vi.fn(),
    };
  }),
}));

vi.mock("../services/signup.js", () => ({
  SignupOperations: vi.fn().mockImplementation(function () {
    return {
      finalizeSignupProcess: mocks.finalizeSignupProcess,
      initiateSignerCreation: vi.fn(),
    };
  }),
}));

vi.mock("../neynar/client.js", () => ({
  default: { lookupSigner: mocks.lookupSigner },
}));

vi.mock("@flashcastr/crypto", () => ({
  decrypt: mocks.decrypt,
  encrypt: vi.fn(),
}));

import type { Pool } from "pg";
import { createUserResolvers } from "./users.js";

const fakePool = {} as Pool;
const originalEncryptionKey = process.env.SIGNER_ENCRYPTION_KEY;

beforeEach(() => {
  mocks.lookupSigner.mockReset();
  mocks.finalizeSignupProcess.mockReset();
  mocks.decrypt.mockReset().mockReturnValue("decrypted-signer-uuid");
  mocks.getByFid.mockReset();
  process.env.SIGNER_ENCRYPTION_KEY = "test-encryption-key";
});

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.SIGNER_ENCRYPTION_KEY;
  else process.env.SIGNER_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("createUserResolvers", () => {
  it("does not expose a signup mutation", () => {
    const { Mutation } = createUserResolvers(fakePool);
    expect(Mutation).not.toHaveProperty("signup");
  });

  it("returns a stable message when checkSignerStatus's Neynar lookup fails, not the raw error", async () => {
    mocks.getByFid.mockResolvedValue({ fid: 42, signer_uuid: "encrypted-blob" });
    mocks.lookupSigner.mockRejectedValue(new Error("neynar 500: upstream blew up"));

    const { Query } = createUserResolvers(fakePool);
    const result = await Query.checkSignerStatus(undefined, { fid: 42 });

    expect(result.message).toBe("Failed to check signer status.");
  });

  it("returns a stable message when pollSignupStatus's Neynar lookup fails, not the raw error", async () => {
    mocks.lookupSigner.mockRejectedValue(new Error("neynar 500: upstream blew up"));

    const { Query } = createUserResolvers(fakePool);
    const result = await Query.pollSignupStatus(undefined, { signer_uuid: "sig-1", username: "alice" });

    expect(result.message).toBe("Failed to lookup signer on Neynar.");
  });

  it("returns a stable message when pollSignupStatus's finalization step fails, not the raw error", async () => {
    mocks.lookupSigner.mockResolvedValue({ status: "approved", fid: 42 });
    mocks.finalizeSignupProcess.mockRejectedValue(new Error("db constraint violated"));

    const { Query } = createUserResolvers(fakePool);
    const result = await Query.pollSignupStatus(undefined, { signer_uuid: "sig-1", username: "alice" });

    expect(result.message).toBe("Failed to finalize user signup.");
  });
});
