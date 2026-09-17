import { describe, expect, it } from "vitest";
import { WhereBuilder, clampLimit, pageOffset } from "./where-builder.js";

describe("WhereBuilder", () => {
  it("numbers placeholders in order and skips blank values", () => {
    const where = new WhereBuilder(["deleted = false"]).eq("fid", 7).eq("username", "").eqIgnoreCase("city", "Paris");
    expect(where.clause()).toBe("WHERE deleted = false AND fid = $1 AND LOWER(city) = LOWER($2)");
    expect(where.params).toEqual([7, "Paris"]);
  });

  it("treats zero as a value, not a blank", () => {
    const where = new WhereBuilder().eq("fid", 0);
    expect(where.clause()).toBe("WHERE fid = $1");
    expect(where.params).toEqual([0]);
  });

  it("returns an empty clause with no conditions", () => {
    expect(new WhereBuilder().clause()).toBe("");
  });

  it("appends pagination params after the conditions", () => {
    const where = new WhereBuilder().eq("a", 1);
    const page = where.paginate(20, 40);
    expect(page).toBe("LIMIT $2 OFFSET $3");
    expect(where.params).toEqual([1, 20, 40]);
  });
});

describe("clampLimit", () => {
  it("uses the fallback when undefined and clamps into range", () => {
    expect(clampLimit(undefined, 20)).toBe(20);
    expect(clampLimit(-5, 20)).toBe(1);
    expect(clampLimit(0, 20)).toBe(1);
    expect(clampLimit(10_000, 20)).toBe(500);
    expect(clampLimit(50, 20, 40)).toBe(40);
    expect(clampLimit(7.9, 20)).toBe(7);
  });
});

describe("pageOffset", () => {
  it("clamps page to 1 and computes the offset", () => {
    expect(pageOffset(undefined, 20)).toBe(0);
    expect(pageOffset(0, 20)).toBe(0);
    expect(pageOffset(3, 20)).toBe(40);
  });
});
