import { asc, eq, isNull, sql } from 'drizzle-orm';
import { flashcastrCorrections, flashcastrCorrectionAudit } from '@life-os/shared';
import type { AgentDb } from '@life-os/shared';

/**
 * Persisted-correction learning loop (story 04). Mirrors kelly-frears
 * `guidance.ts` (`getActiveGuidanceForScope` / `formatCorrectionsBlock` /
 * `retiredAt` retraction): a public correction is stored once, then every
 * generation/reply prompt gets the active corrections block prepended so the
 * wrong claim never recurs. Retired rows (`retiredAt` set) are excluded.
 */

/** Cap the injected block — newest beyond this are dropped (oldest still win for cache stability). */
const MAX_ACTIVE_CORRECTIONS = 30;

export interface ActiveCorrection {
  id: string;
  wrongClaim: string;
  correctFact: string;
  createdAt: Date;
}

export interface NewCorrection {
  wrongClaim: string;
  correctFact: string;
  sourceCastHash?: string | null;
  authorFid: number;
  scope?: string;
}

/**
 * Active (non-retired) corrections, oldest-first. Oldest-first ordering keeps
 * the prompt cache warm: appending a new correction only invalidates the tail
 * of the injected block, not the whole prefix (kelly-frears guidance pattern).
 */
export async function getActiveCorrections(agentDb: AgentDb): Promise<ActiveCorrection[]> {
  return agentDb
    .select({
      id: flashcastrCorrections.id,
      wrongClaim: flashcastrCorrections.wrongClaim,
      correctFact: flashcastrCorrections.correctFact,
      createdAt: flashcastrCorrections.createdAt,
    })
    .from(flashcastrCorrections)
    .where(isNull(flashcastrCorrections.retiredAt))
    .orderBy(asc(flashcastrCorrections.createdAt))
    .limit(MAX_ACTIVE_CORRECTIONS);
}

/**
 * Render the active corrections as a system-prompt block. Empty string when
 * there are none so callers can interpolate it unconditionally without an
 * empty header. Lives in the *task* block (not the static persona) so the
 * persona prefix stays a stable `cacheSystem: true` cache key.
 */
export function formatCorrectionsBlock(rows: ActiveCorrection[]): string {
  if (rows.length === 0) return '';
  const lines = rows.map((r) => {
    const date = r.createdAt.toISOString().slice(0, 10);
    return `- [${date}] NOT "${r.wrongClaim}" — the correct fact: ${r.correctFact}`;
  });
  return [
    'LEARNED CORRECTIONS (non-negotiable — the community corrected you on these; never repeat the wrong claim):',
    ...lines,
    '',
  ].join('\n');
}

/** Persist a new correction. Returns the inserted row id. */
export async function insertCorrection(agentDb: AgentDb, row: NewCorrection): Promise<string> {
  const [inserted] = await agentDb
    .insert(flashcastrCorrections)
    .values({
      wrongClaim: row.wrongClaim,
      correctFact: row.correctFact,
      sourceCastHash: row.sourceCastHash ?? null,
      authorFid: row.authorFid,
      scope: row.scope ?? 'all',
    })
    .returning({ id: flashcastrCorrections.id });
  return inserted!.id;
}

/** Retract a correction so it is excluded from future injected blocks. */
export async function retireCorrection(agentDb: AgentDb, id: string): Promise<void> {
  await agentDb
    .update(flashcastrCorrections)
    .set({ retiredAt: sql`now()` })
    .where(eq(flashcastrCorrections.id, id));
}

/**
 * Hard daily cap on web-search fact-checks of inbound corrections (cost
 * bound on Opus + web_search). Counts audit rows where a verdict was
 * recorded (irrelevant claims are counted as audit rows with verdict NULL
 * and don't burn the budget). Tune via FACT_CHECK_BUDGET_PER_DAY.
 */
export const FACT_CHECK_BUDGET_PER_DAY = 20;

export interface NewCorrectionAudit {
  sourceCastHash: string;
  authorFid: number;
  wrongClaim: string;
  correctFact: string;
  relevant: boolean;
  factCheckVerdict: 'high' | 'low' | 'reject' | null;
  factCheckReasoning: string | null;
  persisted: boolean;
}

/** Persist an audit row for every inbound correction attempt (one per reply). */
export async function insertCorrectionAudit(agentDb: AgentDb, row: NewCorrectionAudit): Promise<void> {
  await agentDb.insert(flashcastrCorrectionAudit).values({
    sourceCastHash: row.sourceCastHash,
    authorFid: row.authorFid,
    wrongClaim: row.wrongClaim,
    correctFact: row.correctFact,
    relevant: row.relevant,
    factCheckVerdict: row.factCheckVerdict,
    factCheckReasoning: row.factCheckReasoning,
    persisted: row.persisted,
  });
}

/**
 * Returns true iff the agent is under its 24h web-search budget for
 * correction fact-checks. Only counts audit rows where a verdict was
 * actually recorded — irrelevant-but-audited claims don't consume budget.
 */
export async function isUnderFactCheckBudget(agentDb: AgentDb): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await agentDb
    .select({ id: flashcastrCorrectionAudit.id })
    .from(flashcastrCorrectionAudit)
    .where(
      sql`${flashcastrCorrectionAudit.factCheckVerdict} IS NOT NULL AND ${flashcastrCorrectionAudit.checkedAt} >= ${since}`,
    );
  return rows.length < FACT_CHECK_BUDGET_PER_DAY;
}
