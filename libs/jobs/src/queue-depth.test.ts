import { Pool as PgPool } from "pg";
import type { Pool } from "pg";
import { Registry } from "prom-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { observeJobBacklog } from "./queue-depth.js";

class FakePool {
  constructor(
    private readonly stateRows: Record<string, { state: string; count: number }[]>,
    private readonly ageRows: Record<string, number> = {}
  ) {}

  async query(sql: string, params: unknown[] = []) {
    const stage = params[0] as string;
    if (/EXTRACT\(EPOCH/.test(sql)) {
      const age = this.ageRows[stage];
      return { rows: [{ age_seconds: age ?? null }] };
    }
    return { rows: this.stateRows[stage] ?? [] };
  }
}

async function metricValues(registry: Registry, name: string) {
  const json = await registry.getMetricsAsJSON();
  return (json.find((entry) => entry.name === name) as
    | { values: { labels: Record<string, string>; value: number }[] }
    | undefined)?.values;
}

describe("observeJobBacklog", () => {
  it("sets flash_jobs_backlog per stage/state from the query results", async () => {
    const registry = new Registry();
    const pool = new FakePool({
      pin: [
        { state: "ready", count: 3 },
        { state: "leased", count: 1 },
        { state: "dead", count: 2 },
      ],
    });

    const stop = observeJobBacklog(registry, pool as unknown as Pool, [{ stage: "pin", maxAttempts: 5 }]);
    await new Promise((resolve) => setImmediate(resolve));
    stop();

    const values = await metricValues(registry, "flash_jobs_backlog");
    expect(values).toEqual(
      expect.arrayContaining([
        { labels: { stage: "pin", state: "ready" }, value: 3 },
        { labels: { stage: "pin", state: "leased" }, value: 1 },
        { labels: { stage: "pin", state: "dead" }, value: 2 },
      ])
    );
  });

  it("sets a state to 0 when the group-by query omits it (no rows in that state)", async () => {
    const registry = new Registry();
    const pool = new FakePool({
      cast: [{ state: "ready", count: 5 }],
    });

    const stop = observeJobBacklog(registry, pool as unknown as Pool, [{ stage: "cast", maxAttempts: 3 }]);
    await new Promise((resolve) => setImmediate(resolve));
    stop();

    const values = await metricValues(registry, "flash_jobs_backlog");
    expect(values).toEqual(
      expect.arrayContaining([
        { labels: { stage: "cast", state: "ready" }, value: 5 },
        { labels: { stage: "cast", state: "leased" }, value: 0 },
        { labels: { stage: "cast", state: "dead" }, value: 0 },
      ])
    );
  });

  it("sets flash_jobs_oldest_ready_seconds from the age query, 0 when there is no ready job", async () => {
    const registry = new Registry();
    const pool = new FakePool(
      { pin: [{ state: "ready", count: 1 }], cast: [] },
      { pin: 123.5 }
    );

    const stop = observeJobBacklog(registry, pool as unknown as Pool, [
      { stage: "pin", maxAttempts: 5 },
      { stage: "cast", maxAttempts: 5 },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    stop();

    const values = await metricValues(registry, "flash_jobs_oldest_ready_seconds");
    expect(values).toEqual(
      expect.arrayContaining([
        { labels: { stage: "pin" }, value: 123.5 },
        { labels: { stage: "cast" }, value: 0 },
      ])
    );
  });

  it("does not throw when called twice against the same registry", async () => {
    const registry = new Registry();
    const pool = new FakePool({ pin: [] });

    const stopFirst = observeJobBacklog(registry, pool as unknown as Pool, [{ stage: "pin", maxAttempts: 5 }]);
    expect(() =>
      observeJobBacklog(registry, pool as unknown as Pool, [{ stage: "pin", maxAttempts: 5 }])
    ).not.toThrow();
    stopFirst();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("observeJobBacklog against a real Postgres", () => {
  let pool: PgPool;

  beforeAll(() => {
    pool = new PgPool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE flash_jobs, flashes CASCADE");
  });

  it("classifies a job killed via the NEVER_RETRY_AT_MS sentinel as dead, not leased", async () => {
    await pool.query(
      `INSERT INTO flashes (flash_id, city, player, img, ipfs_cid, text, timestamp, flash_count)
       VALUES (1001, 'Paris', 'player-one', 'https://example.com/img.png', 'bafybeitest', 'flash text', now(), '1')`
    );
    // Mirrors JobWorker.settleFailure's non-retryable path: attempts stays
    // low (killed on its very first attempt) but next_attempt_at is pushed
    // far into the future so it's never naturally reclaimed.
    await pool.query(
      `INSERT INTO flash_jobs (flash_id, stage, attempts, next_attempt_at, last_error)
       VALUES (1001, 'pin', 1, now() + interval '200 years', 'poison')`
    );

    const registry = new Registry();
    const stop = observeJobBacklog(registry, pool as unknown as Pool, [{ stage: "pin", maxAttempts: 5 }], 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    const json = await registry.getMetricsAsJSON();
    const backlog = json.find((entry) => entry.name === "flash_jobs_backlog") as
      | { values: { labels: Record<string, string>; value: number }[] }
      | undefined;

    const deadValue = backlog?.values.find(
      (value) => value.labels.stage === "pin" && value.labels.state === "dead"
    )?.value;
    const leasedValue = backlog?.values.find(
      (value) => value.labels.stage === "pin" && value.labels.state === "leased"
    )?.value;

    expect(deadValue).toBe(1);
    expect(leasedValue).toBe(0);
  });
});
