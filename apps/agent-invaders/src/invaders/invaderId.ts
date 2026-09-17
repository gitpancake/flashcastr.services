export interface InvaderId {
  readonly cityCode: string;
  readonly number: number;
}

const INVADER_ID_PATTERN = /\b([A-Z]{2,6})[_-]?(\d{1,4})\b/g;

export function formatInvaderId(id: InvaderId): string {
  const padded = id.number < 10 ? `0${id.number}` : `${id.number}`;
  return `${id.cityCode}_${padded}`;
}

export function parseInvaderId(raw: string): InvaderId | null {
  const match = /^([A-Za-z]{2,6})[_\s-]?(\d{1,4})$/.exec(raw.trim());
  if (!match) return null;
  return { cityCode: match[1]!.toUpperCase(), number: Number(match[2])};
}

export function extractInvaderIds(text: string): InvaderId[] {
  const seen = new Map<string, InvaderId>();
  for (const match of text.toUpperCase().matchAll(INVADER_ID_PATTERN)) {
    const id = { cityCode: match[1]!, number: Number(match[2]) };
    seen.set(formatInvaderId(id), id);
  }
  return [...seen.values()];
}

export function sameInvader(a: InvaderId, b: InvaderId): boolean {
  return a.cityCode === b.cityCode && a.number === b.number;
}
