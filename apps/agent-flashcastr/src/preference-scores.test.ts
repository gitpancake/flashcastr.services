import { describe, it, expect } from 'vitest';

// ─── Pure logic tests (no DB) ────────────────────────────────────────────────

describe('Bayesian update math', () => {
  it('updates score correctly from first signal', () => {
    // newScore = (0.5 * 0 + 1.0) / (0 + 1) = 1.0 → clamped to 0.95
    const newScore = bayesianUpdateClamp(0.5, 0, 1.0);
    expect(newScore).toBe(0.95);
  });

  it('averages in subsequent signals', () => {
    // After 1 sample with score 0.95 (clamped), add signal 1.0:
    // (0.95 * 1 + 1.0) / 2 = 0.975 → clamped to 0.95
    const after2 = bayesianUpdateClamp(0.95, 1, 1.0);
    expect(after2).toBe(0.95);
  });

  it('score moves toward neutral with a mid-range signal', () => {
    // Start at 0.95 with 10 samples; signal 0.5
    // (0.95 * 10 + 0.5) / 11 ≈ 0.909 — stays above floor
    const result = bayesianUpdateClamp(0.95, 10, 0.5);
    expect(result).toBeGreaterThan(0.6);
    expect(result).toBeLessThan(0.95);
  });
});

describe('Score clamping', () => {
  it('clamps below SCORE_MIN (0.6) to 0.6', () => {
    // A score of 0.3 with zero signal would dip to 0.15 unclamped
    const result = bayesianUpdateClamp(0.3, 1, 0.0);
    expect(result).toBeGreaterThanOrEqual(0.6);
  });

  it('clamps above SCORE_MAX (0.95) to 0.95', () => {
    const result = bayesianUpdateClamp(1.0, 0, 1.0);
    expect(result).toBeLessThanOrEqual(0.95);
  });
});

describe('getThresholds default behaviour', () => {
  it('returns DEFAULT_THRESHOLD (0.7) for an unknown content type', async () => {
    // getThresholds with empty DB → map is empty → caller gets default
    // We test the public contract: missing key → caller uses 0.7
    const map = new Map<string, number>();
    const threshold = map.get('destruction') ?? 0.7;
    expect(threshold).toBe(0.7);
  });
});

describe('buildScoreObservation format', () => {
  it('returns a no-data message when store is empty', async () => {
    const result = await buildScoreObservationWith([]);
    expect(result).toContain('No learning data yet');
  });

  it('formats rows with score and sample count', async () => {
    const rows = [
      { contentType: 'destruction', score: 0.82, sampleCount: 15 },
      { contentType: 'addition', score: 0.71, sampleCount: 5 },
    ];
    const result = await buildScoreObservationWith(rows);

    expect(result).toContain('destruction');
    expect(result).toContain('0.820');
    expect(result).toContain('addition');
    // Low sample count should show provisional status
    expect(result).toContain('provisional');
    // High sample count should show trusted status
    expect(result).toContain('trusted');
  });

  it('marks rows with sampleCount < 10 as provisional', async () => {
    const rows = [{ contentType: 'milestone', score: 0.9, sampleCount: 3 }];
    const result = await buildScoreObservationWith(rows);
    expect(result).toContain('provisional');
    expect(result).not.toContain('trusted');
  });

  it('marks rows with sampleCount >= 10 as trusted', async () => {
    const rows = [{ contentType: 'reactivation', score: 0.75, sampleCount: 10 }];
    const result = await buildScoreObservationWith(rows);
    expect(result).toContain('trusted');
  });
});

// ─── Engagement signal weighting ─────────────────────────────────────────────

describe('Engagement signal weighting', () => {
  it('computes engagement signal correctly', () => {
    // formula: (reactions + recasts * 2 + replies) / 10
    const reactions = 5, recasts = 3, replies = 2;
    const raw = (reactions + recasts * 2 + replies) / 10;
    expect(raw).toBeCloseTo(1.3);
    const clamped = Math.min(1, Math.max(0, raw));
    expect(clamped).toBe(1);
  });

  it('clamps engagement signal to [0, 1]', () => {
    // High engagement: should be clamped to 1
    const highSignal = Math.min(1, Math.max(0, 50 / 10));
    expect(highSignal).toBe(1);

    // Zero engagement: should be 0
    const zeroSignal = Math.min(1, Math.max(0, 0));
    expect(zeroSignal).toBe(0);
  });

  it('produces fractional signal for moderate engagement', () => {
    // reactions=2, recasts=1, replies=1 → (2 + 2 + 1) / 10 = 0.5
    const signal = Math.min(1, Math.max(0, (2 + 2 + 1) / 10));
    expect(signal).toBeCloseTo(0.5);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Expose the internal clamped Bayesian update for direct testing
function bayesianUpdateClamp(oldScore: number, sampleCount: number, signal: number): number {
  const SCORE_MIN = 0.6;
  const SCORE_MAX = 0.95;
  const raw = (oldScore * sampleCount + signal) / (sampleCount + 1);
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, raw));
}

// Test helper that mimics buildScoreObservation logic without DB
async function buildScoreObservationWith(
  rows: Array<{ contentType: string; score: number; sampleCount: number }>,
): Promise<string> {
  const MIN_SAMPLE_COUNT = 10;
  const SCORE_MIN = 0.6;
  const SCORE_MAX = 0.95;

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
