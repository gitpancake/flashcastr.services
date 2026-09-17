import { describe, expect, it } from "vitest";
import { formatLogArgs } from "./index.js";

describe("formatLogArgs", () => {
  it("renders an Error with its message and stack instead of {}", () => {
    const err = new Error("boom");
    const out = formatLogArgs(["Failed:", err]);
    expect(out).toContain("Failed:");
    expect(out).toContain("boom");
    expect(out).toContain("at ");
    expect(out).not.toContain("{}");
  });

  it("serializes Errors nested inside objects", () => {
    const out = formatLogArgs([{ cause: new Error("inner") }]);
    expect(out).toContain('"message":"inner"');
  });

  it("stringifies plain values and objects", () => {
    expect(formatLogArgs(["a", 1, { b: 2 }, null])).toBe('a 1 {"b":2} null');
  });

  it("does not throw on circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLogArgs([circular])).not.toThrow();
  });
});
