import { describe, expect, it } from "vitest";
import { createDefaultCastValidator } from "../src/validation/defaultCastValidator.js";

const validator = createDefaultCastValidator();

describe("cast validator chain", () => {
  it("accepts a grounded, short, in-character cast", () => {
    const verdict = validator.validate({ text: "PA_04 is holding on, degraded but flashed last week 👾", allowedInvaderIds: new Set(["PA_04"]) });
    expect(verdict).toEqual({ ok: true, reasons: [] });
  });

  it("rejects invader ids that have no source data", () => {
    const verdict = validator.validate({ text: "PA_04 and PA_999 both gone", allowedInvaderIds: new Set(["PA_04"]) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain("PA_999");
  });

  it("collects reasons from every link in the chain", () => {
    const verdict = validator.validate({ text: `As an AI I can't comment on ${"x".repeat(330)}`, allowedInvaderIds: new Set() });
    expect(verdict.reasons).toHaveLength(3);
  });
});
