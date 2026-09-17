import type { InvaderId } from "./invaderId.js";

export type InvaderCondition =
  | "ok"
  | "slightly_degraded"
  | "degraded"
  | "heavily_degraded"
  | "destroyed"
  | "not_visible"
  | "unknown";

export interface SpotterComment {
  readonly author: string;
  readonly date: string;
  readonly text: string;
}

export interface InvaderStatus {
  readonly id: InvaderId;
  readonly displayId: string;
  readonly cityCode: string;
  readonly cityName: string | null;
  readonly district: string | null;
  readonly points: number | null;
  readonly installedOn: string | null;
  readonly condition: InvaderCondition;
  readonly conditionLabel: string;
  readonly conditionReportedAt: string | null;
  readonly closeUpImageUrl: string | null;
  readonly photoUrls: readonly string[];
  readonly recentComments: readonly SpotterComment[];
  readonly sourceUrl: string;
  readonly fetchedAt: string;
}

const FRENCH_CONDITION_LABELS: ReadonlyArray<readonly [RegExp, InvaderCondition, string]> = [
  [/tr[eè]s d[ée]grad[ée]/i, "heavily_degraded", "heavily degraded"],
  [/un peu d[ée]grad[ée]/i, "slightly_degraded", "slightly degraded"],
  [/d[ée]grad[ée]/i, "degraded", "degraded"],
  [/d[ée]truit/i, "destroyed", "destroyed"],
  [/non visible/i, "not_visible", "not visible"],
  [/inconnu/i, "unknown", "unknown"],
  [/\bok\b/i, "ok", "OK"],
];

export function conditionFromFrench(label: string): { condition: InvaderCondition; conditionLabel: string } {
  for (const [pattern, condition, conditionLabel] of FRENCH_CONDITION_LABELS) {
    if (pattern.test(label)) return { condition, conditionLabel };
  }
  return { condition: "unknown", conditionLabel: "unknown" };
}

export function describeStatus(status: InvaderStatus): string {
  const city = status.cityName ?? status.cityCode;
  const where = status.district ? `${city}, ${status.district}` : city;
  const points = status.points === null ? "" : ` (${status.points} pts)`;
  const installed = status.installedOn ? `, installed ${status.installedOn}` : "";
  const reported = status.conditionReportedAt ? ` as of ${status.conditionReportedAt}` : "";
  const comments = status.recentComments
    .map((comment) => `  - ${comment.date} ${comment.author}: ${comment.text}`)
    .join("\n");
  const commentBlock = comments ? `\n  recent spotter reports:\n${comments}` : "";
  return `${status.displayId}${points} in ${where}${installed}. Last known condition: ${status.conditionLabel}${reported}.${commentBlock}`;
}
