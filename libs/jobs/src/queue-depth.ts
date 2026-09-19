import type { Pool } from "pg";
import { Gauge, type Registry } from "prom-client";
import type { FlashJobStage } from "@flashcastr/database";

export interface JobBacklogStageConfig {
  stage: FlashJobStage;
  maxAttempts: number;
}

const BACKLOG_GAUGE_NAME = "flash_jobs_backlog";
const OLDEST_READY_GAUGE_NAME = "flash_jobs_oldest_ready_seconds";
const DEFAULT_INTERVAL_MS = 30000;

type BacklogState = "ready" | "leased" | "dead";
const BACKLOG_STATES: BacklogState[] = ["ready", "leased", "dead"];

function backlogGauge(registry: Registry): Gauge<"stage" | "state"> {
  const existing = registry.getSingleMetric(BACKLOG_GAUGE_NAME) as Gauge<"stage" | "state"> | undefined;
  if (existing) return existing;
  return new Gauge({
    name: BACKLOG_GAUGE_NAME,
    help: "flash_jobs rows by stage and state (ready/leased/dead)",
    labelNames: ["stage", "state"] as const,
    registers: [registry],
  });
}

function oldestReadyGauge(registry: Registry): Gauge<"stage"> {
  const existing = registry.getSingleMetric(OLDEST_READY_GAUGE_NAME) as Gauge<"stage"> | undefined;
  if (existing) return existing;
  return new Gauge({
    name: OLDEST_READY_GAUGE_NAME,
    help: "Age in seconds of the oldest ready flash_jobs row for a stage",
    labelNames: ["stage"] as const,
    registers: [registry],
  });
}

const STATE_COUNTS_SQL = `
  SELECT
    CASE WHEN attempts >= $2 THEN 'dead'
         WHEN next_attempt_at <= now() THEN 'ready'
         ELSE 'leased' END AS state,
    count(*)::int AS count
  FROM flash_jobs WHERE stage = $1
  GROUP BY state
`;

const OLDEST_READY_SQL = `
  SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) AS age_seconds
  FROM flash_jobs WHERE stage = $1 AND attempts < $2 AND next_attempt_at <= now()
`;

async function sampleStage(
  pool: Pool,
  backlog: Gauge<"stage" | "state">,
  oldestReady: Gauge<"stage">,
  { stage, maxAttempts }: JobBacklogStageConfig
): Promise<void> {
  const { rows: stateRows } = await pool.query(STATE_COUNTS_SQL, [stage, maxAttempts]);
  const countByState = new Map<string, number>(stateRows.map((row: { state: string; count: number }) => [row.state, row.count]));
  for (const state of BACKLOG_STATES) {
    backlog.set({ stage, state }, countByState.get(state) ?? 0);
  }

  const { rows: ageRows } = await pool.query(OLDEST_READY_SQL, [stage, maxAttempts]);
  const ageSeconds = ageRows[0]?.age_seconds;
  oldestReady.set({ stage }, ageSeconds == null ? 0 : Number(ageSeconds));
}

/**
 * Periodically samples the flash_jobs table into flash_jobs_backlog (per
 * stage/state) and flash_jobs_oldest_ready_seconds (per stage) gauges.
 * Returns a stop function.
 */
export function observeJobBacklog(
  registry: Registry,
  pool: Pool,
  stages: JobBacklogStageConfig[],
  intervalMs = DEFAULT_INTERVAL_MS
): () => void {
  const backlog = backlogGauge(registry);
  const oldestReady = oldestReadyGauge(registry);

  const sample = async () => {
    for (const stageConfig of stages) {
      await sampleStage(pool, backlog, oldestReady, stageConfig).catch(() => undefined);
    }
  };

  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref();
  void sample();
  return () => clearInterval(timer);
}
