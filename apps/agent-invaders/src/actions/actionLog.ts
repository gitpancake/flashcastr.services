export type ActionOutcome = "ok" | "failed" | "skipped";

export interface ActionRecord {
  readonly actor: string;
  readonly action: string;
  readonly outcome: ActionOutcome;
  readonly threadId?: string;
  readonly subject?: string;
  readonly detail?: Record<string, unknown>;
}

export interface ActionLog {
  record(entry: ActionRecord): Promise<void>;
  countRecent(action: string, subject: string, sinceMs: number): Promise<number>;
}

export async function recordOutcome<T>(log: ActionLog, entry: Omit<ActionRecord, "outcome">, work: () => Promise<T>): Promise<T> {
  try {
    const value = await work();
    await log.record({ ...entry, outcome: "ok", detail: { ...entry.detail, result: summarize(value) } });
    return value;
  } catch (error) {
    await log.record({ ...entry, outcome: "failed", detail: { ...entry.detail, error: errorMessage(error) } });
    throw error;
  }
}

function summarize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "object" && value !== null) return JSON.parse(JSON.stringify(value));
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
