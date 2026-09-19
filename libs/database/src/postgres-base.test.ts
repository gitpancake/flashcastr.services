import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withTransaction } from "./postgres-base.js";

function fakeClient() {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { client: client as unknown as PoolClient, calls, release: client.release };
}

describe("withTransaction", () => {
  it("commits and releases when work resolves, returning work's result", async () => {
    const { client, calls, release } = fakeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    const result = await withTransaction(pool, async () => "ok");

    expect(calls).toEqual(["BEGIN", "COMMIT"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(result).toBe("ok");
  });

  it("rolls back, releases, and rethrows when work rejects", async () => {
    const { client, calls, release } = fakeClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(withTransaction(pool, async () => { throw new Error("boom"); })).rejects.toThrow("boom");

    expect(calls).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
