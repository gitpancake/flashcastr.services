import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidNeynarSignature } from "../src/farcaster/neynarSignature.js";

describe("neynar webhook signature", () => {
  const secret = "topsecret";
  const body = Buffer.from(JSON.stringify({ type: "cast.created" }));
  const signature = createHmac("sha512", secret).update(body).digest("hex");

  it("accepts a matching sha512 hmac", () => {
    expect(isValidNeynarSignature(body, signature, secret)).toBe(true);
  });

  it("rejects missing, malformed or tampered signatures", () => {
    expect(isValidNeynarSignature(body, undefined, secret)).toBe(false);
    expect(isValidNeynarSignature(body, "zz", secret)).toBe(false);
    expect(isValidNeynarSignature(Buffer.from("{}"), signature, secret)).toBe(false);
  });
});
