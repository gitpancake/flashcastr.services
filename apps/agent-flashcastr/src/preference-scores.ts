import { eq, and, isNull } from 'drizzle-orm';
import type { AgentDb } from '@life-os/shared';
import { flashcastrPreferenceScores } from '@life-os/shared';

// Clamp range: keep scores in a useful band — never fully suppressing a type
// (floor 0.6) and never trusting sparse data too much (ceiling 0.95).
const SCORE_MIN = 0.6;
const SCORE_MAX = 0.95;

// Minimum samples before we trust a score over the default 0.7 threshold.
const MIN_SAMPLE_COUNT = 10;
export const DEFAULT_THRESHOLD = 0.7;

export interface SignalDimensions {
  contentType: string;
  city?: string;
  noveltyBucket?: string;
}

/**
 * Ingest a learning signal for a suggestion dimension using a Bayesian running mean:
 *   newScore = (oldScore * sampleCount + signal) / (sampleCount + 1)
 *
 * score is clamped to [0.6, 0.95] — positive (pick accepted) signal ≈ 1.0,
 * engagement-weighted signals will arrive in (0, 1] via PR2.
 *
 * Uses select-then-write: the unique index has nullable columns (NULL != NULL in Postgres),
 * so standard ON CONFLICT upsert is unreliable. Single-process agent makes race conditions moot.
 */
export async function pushSignal(
  db: AgentDb,
  dimensions: SignalDimensions,
  signal: number,
): Promise<void> {
  const { contentType, city = null, noveltyBucket = null } = dimensions;

  const cityCondition = city ? eq(flashcastrPreferenceScores.city, city) : isNull(flashcastrPreferenceScores.city);
  const noveltyCondition = noveltyBucket
    ? eq(flashcastrPreferenceScores.noveltyBucket, noveltyBucket)
    : isNull(flashcastrPreferenceScores.noveltyBucket);

  const existing = await db
    .select({
      id: flashcastrPreferenceScores.id,
      score: flashcastrPreferenceScores.score,
      sampleCount: flashcastrPreferenceScores.sampleCount,
    })
    .from(flashcastrPreferenceScores)
    .where(and(
      eq(flashcastrPreferenceScores.contentType, contentType),
      cityCondition,
      noveltyCondition,
    ))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(flashcastrPreferenceScores).values({
      contentType,
      city: city ?? undefined,
      noveltyBucket: noveltyBucket ?? undefined,
      score: bayesianUpdate(0.5, 0, signal),
      sampleCount: 1,
      lastUpdatedAt: new Date(),
    });
    return;
  }

  const row = existing[0]!;
  await db
    .update(flashcastrPreferenceScores)
    .set({
      score: bayesianUpdate(row.score, row.sampleCount, signal),
      sampleCount: row.sampleCount + 1,
      lastUpdatedAt: new Date(),
    })
    .where(eq(flashcastrPreferenceScores.id, row.id));
}

/**
 * Return per-contentType confidence thresholds learned from accepted suggestions.
 * Falls back to DEFAULT_THRESHOLD (0.7) when sampleCount < MIN_SAMPLE_COUNT.
 */
export async function getThresholds(
  db: AgentDb,
): Promise<Map<string, number>> {
  // Aggregate by contentType only — city/novelty dimensions are for fine-grained
  // future use; the prompt injection uses per-type thresholds for now.
  const rows = await db
    .select({
      contentType: flashcastrPreferenceScores.contentType,
      score: flashcastrPreferenceScores.score,
      sampleCount: flashcastrPreferenceScores.sampleCount,
    })
    .from(flashcastrPreferenceScores)
    .where(and(
      isNull(flashcastrPreferenceScores.city),
      isNull(flashcastrPreferenceScores.noveltyBucket),
    ));

  const thresholds = new Map<string, number>();
  for (const row of rows) {
    // Only trust scores backed by enough samples
    const threshold = row.sampleCount >= MIN_SAMPLE_COUNT ? row.score : DEFAULT_THRESHOLD;
    thresholds.set(row.contentType, threshold);
  }
  return thresholds;
}

/**
 * Build a human-readable summary of per-contentType scores for OV observation.
 */
export async function buildScoreObservation(
  db: AgentDb,
): Promise<string> {
  const rows = await db
    .select()
    .from(flashcastrPreferenceScores)
    .where(and(
      isNull(flashcastrPreferenceScores.city),
      isNull(flashcastrPreferenceScores.noveltyBucket),
    ));

  if (rows.length === 0) {
    return '# Flashcastr Suggestion Patterns\n\nNo learning data yet — scores will populate after accepted suggestions.\n';
  }

  const lines = rows
    .sort((a, b) => b.score - a.score)
    .map((r) => {
      const trusted = r.sampleCount >= MIN_SAMPLE_COUNT;
      const status = trusted ? 'trusted' : `provisional (n=${r.sampleCount}, need ${MIN_SAMPLE_COUNT})`;
      return `- **${r.contentType}**: score=${r.score.toFixed(3)}, samples=${r.sampleCount} — ${status}`;
    })
    .join('\n');

  const updatedAt = new Date().toISOString().split('T')[0];
  return `# Flashcastr Suggestion Patterns\n\nLearned confidence thresholds from accepted picks. Updated ${updatedAt}.\n\n## Per-ContentType Scores\n\n${lines}\n\n## Notes\n\n- Default threshold used until sampleCount >= ${MIN_SAMPLE_COUNT}\n- Scores clamped to [${SCORE_MIN}, ${SCORE_MAX}]\n- Positive signal (pick accepted) = 1.0; engagement-weighted signals arrive in PR2\n`;
}

// ─── Internal ────────────────────────────────────────────────────────────────

function bayesianUpdate(oldScore: number, sampleCount: number, signal: number): number {
  const raw = (oldScore * sampleCount + signal) / (sampleCount + 1);
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, raw));
}
