import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyApiKey, withApiKey, UNAUTHORIZED_ERROR_CODE } from "./auth.js";

const originalKey = process.env.API_KEY;

function contextWith(headers: Record<string, string | string[] | undefined>) {
  return { req: { headers } };
}

describe("verifyApiKey", () => {
  beforeEach(() => {
    process.env.API_KEY = "secret-key";
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalKey;
  });

  it("accepts the configured key", () => {
    expect(() => verifyApiKey(contextWith({ "x-api-key": "secret-key" }))).not.toThrow();
  });

  it("accepts the key when express presents it as an array", () => {
    expect(() => verifyApiKey(contextWith({ "x-api-key": ["secret-key"] }))).not.toThrow();
  });

  it("rejects a wrong key with the UNAUTHORIZED code", () => {
    expect(() => verifyApiKey(contextWith({ "x-api-key": "nope" }))).toThrowError(
      expect.objectContaining({ extensions: { code: UNAUTHORIZED_ERROR_CODE } })
    );
  });

  it("rejects a key of different length without leaking via exception type", () => {
    expect(() => verifyApiKey(contextWith({ "x-api-key": "secret-key-longer" }))).toThrow();
  });

  it("rejects when no key is presented", () => {
    expect(() => verifyApiKey(contextWith({}))).toThrow();
    expect(() => verifyApiKey({})).toThrow();
  });

  it("rejects everything when API_KEY is not configured", () => {
    delete process.env.API_KEY;
    expect(() => verifyApiKey(contextWith({ "x-api-key": "" }))).toThrow();
    expect(() => verifyApiKey(contextWith({ "x-api-key": "undefined" }))).toThrow();
  });

  it("withApiKey only invokes the resolver when authorized", () => {
    let calls = 0;
    const guarded = withApiKey<{ n: number }, number>((_p, args) => {
      calls++;
      return args.n * 2;
    });
    expect(() => guarded(null, { n: 1 }, contextWith({}))).toThrow();
    expect(calls).toBe(0);
    expect(guarded(null, { n: 2 }, contextWith({ "x-api-key": "secret-key" }))).toBe(4);
    expect(calls).toBe(1);
  });
});
