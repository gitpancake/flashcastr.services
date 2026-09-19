import { describe, expect, it } from "vitest";
import { buildCastIdemKey } from "../src/castGateway.js";
import { buildFlashCast } from "../src/neynarCastGateway.js";

describe("buildCastIdemKey", () => {
  it("returns the same key for the same flash id", () => {
    expect(buildCastIdemKey(42)).toBe(buildCastIdemKey(42));
  });

  it("returns different keys for different flash ids", () => {
    expect(buildCastIdemKey(42)).not.toBe(buildCastIdemKey(43));
  });
});

describe("buildFlashCast", () => {
  it("attaches the deterministic idem key for the flash id", () => {
    expect(buildFlashCast("signer-1", 42, "Paris").idem).toBe(buildCastIdemKey(42));
  });
});
