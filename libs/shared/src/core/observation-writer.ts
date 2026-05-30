/**
 * Transforms numerical preference scores into human-readable observation summaries
 * for writing to OpenViking. Only reports significant patterns — not noise.
 */

export interface ScoreRow {
  category: string;
  value: string;
  score: number;
  signalCount: number;
}

export interface SummaryConfig {
  /** Score threshold for "strong preference" (default 0.65) */
  strongThreshold?: number;
  /** Score threshold for "disliked / avoided" (default 0.3) */
  weakThreshold?: number;
  /** Minimum signals before reporting (default 3) */
  minSignals?: number;
  /** Max items per category in output (default 8) */
  maxPerCategory?: number;
}

interface CategorizedInsight {
  category: string;
  strong: Array<{ value: string; score: number; signals: number }>;
  weak: Array<{ value: string; score: number; signals: number }>;
}

/**
 * Summarize preference scores into a markdown observation.
 * Only includes items with enough signals and meaningful deviation from neutral (0.5).
 */
export function summarizePreferenceScores(
  scores: ScoreRow[],
  agentName: string,
  config: SummaryConfig = {},
): string {
  const {
    strongThreshold = 0.65,
    weakThreshold = 0.3,
    minSignals = 3,
    maxPerCategory = 8,
  } = config;

  // Filter to significant scores only
  const significant = scores.filter(s =>
    s.signalCount >= minSignals && (s.score >= strongThreshold || s.score <= weakThreshold)
  );

  if (significant.length === 0) {
    return `# ${agentName} — Learned Preferences\n\nNo significant patterns yet (need more signals).`;
  }

  // Group by category
  const byCategory = new Map<string, CategorizedInsight>();
  for (const s of significant) {
    if (!byCategory.has(s.category)) {
      byCategory.set(s.category, { category: s.category, strong: [], weak: [] });
    }
    const group = byCategory.get(s.category)!;
    const entry = { value: s.value, score: s.score, signals: s.signalCount };
    if (s.score >= strongThreshold) {
      group.strong.push(entry);
    } else {
      group.weak.push(entry);
    }
  }

  // Build markdown
  let md = `# ${agentName} — Learned Preferences\n\n`;
  md += `_Updated: ${new Date().toISOString().split('T')[0]}_\n\n`;

  for (const [, group] of byCategory) {
    md += `## ${group.category}\n\n`;

    if (group.strong.length > 0) {
      const sorted = group.strong.sort((a, b) => b.score - a.score).slice(0, maxPerCategory);
      md += `**Preferred:**\n`;
      for (const item of sorted) {
        md += `- ${item.value} (score: ${item.score.toFixed(2)}, ${item.signals} signals)\n`;
      }
      md += '\n';
    }

    if (group.weak.length > 0) {
      const sorted = group.weak.sort((a, b) => a.score - b.score).slice(0, maxPerCategory);
      md += `**Avoided/disliked:**\n`;
      for (const item of sorted) {
        md += `- ${item.value} (score: ${item.score.toFixed(2)}, ${item.signals} signals)\n`;
      }
      md += '\n';
    }
  }

  return md.trim();
}

/**
 * Summarize behavioral patterns (day_of_week, time_of_day, duration) into prose.
 * These are gym/activity-specific patterns tracked via completion events.
 */
export function summarizeBehavioralPatterns(
  scores: ScoreRow[],
): string | null {
  const dayScores = scores.filter(s => s.category === 'day_of_week' && s.signalCount >= 3);
  const timeScores = scores.filter(s => s.category === 'time_of_day' && s.signalCount >= 3);
  const durationScores = scores.filter(s => s.category === 'duration' && s.signalCount >= 3);

  const lines: string[] = [];

  if (dayScores.length > 0) {
    const active = dayScores.filter(s => s.score >= 0.6).sort((a, b) => b.score - a.score);
    const rest = dayScores.filter(s => s.score < 0.4).sort((a, b) => a.score - b.score);
    if (active.length > 0) lines.push(`Most active days: ${active.map(s => s.value).join(', ')}`);
    if (rest.length > 0) lines.push(`Usually rests on: ${rest.map(s => s.value).join(', ')}`);
  }

  if (timeScores.length > 0) {
    const preferred = timeScores.sort((a, b) => b.score - a.score)[0];
    if (preferred && preferred.score >= 0.6) lines.push(`Preferred time: ${preferred.value}`);
  }

  if (durationScores.length > 0) {
    const preferred = durationScores.sort((a, b) => b.score - a.score)[0];
    if (preferred && preferred.score >= 0.6) lines.push(`Preferred duration: ${preferred.value}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}
