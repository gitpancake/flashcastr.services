import { describe, expect, it } from "vitest";
import { decodeFlashCursor, encodeFlashCursor } from "./cursor.js";

describe("encodeFlashCursor / decodeFlashCursor", () => {
  it("round-trips a timestamp and flash id", () => {
    const cursor = encodeFlashCursor("1700000000", "12345");
    expect(decodeFlashCursor(cursor)).toEqual({ timestampEpochSeconds: "1700000000", flashId: "12345" });
  });

  it("round-trips a null timestamp", () => {
    const cursor = encodeFlashCursor(null, "12345");
    expect(decodeFlashCursor(cursor)).toEqual({ timestampEpochSeconds: null, flashId: "12345" });
  });

  it("produces a base64url string with no JSON punctuation", () => {
    const cursor = encodeFlashCursor("1700000000", "12345");
    expect(cursor).not.toMatch(/[[\]"{}]/);
  });
});

describe("decodeFlashCursor invalid input", () => {
  it("throws on non-base64 garbage that does not decode to an array", () => {
    expect(() => decodeFlashCursor("not-a-valid-cursor")).toThrow();
  });

  it("throws when the decoded shape is not a 2-element array", () => {
    const badCursor = Buffer.from(JSON.stringify(["only-one"])).toString("base64url");
    expect(() => decodeFlashCursor(badCursor)).toThrow(/cursor/i);
  });

  it("throws when flashId is not a string", () => {
    const badCursor = Buffer.from(JSON.stringify(["1700000000", 12345])).toString("base64url");
    expect(() => decodeFlashCursor(badCursor)).toThrow(/cursor/i);
  });

  it("throws when timestampEpochSeconds is neither null nor a string", () => {
    const badCursor = Buffer.from(JSON.stringify([1700000000, "12345"])).toString("base64url");
    expect(() => decodeFlashCursor(badCursor)).toThrow(/cursor/i);
  });
});
