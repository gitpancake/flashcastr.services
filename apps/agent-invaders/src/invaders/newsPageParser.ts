import { districtToCityCode } from "./cityCodes.js";
import { stripTags } from "./htmlText.js";
import { formatInvaderId, parseInvaderId, type InvaderId } from "./invaderId.js";

export type NewsEventKind =
  | "destruction"
  | "degradation"
  | "reactivation"
  | "restoration"
  | "addition"
  | "alert"
  | "status_update";

export interface InvaderNewsEvent {
  readonly id: InvaderId;
  readonly displayId: string;
  readonly cityCode: string;
  readonly districtCode: string;
  readonly kind: NewsEventKind;
  readonly date: string;
  readonly sentence: string;
}

const MONTH_SECTION = /id='croix(\d{4})(\d{2})'/;
const NEWS_PARAGRAPH = /<p class='news'>([\s\S]*?)<\/p>/g;
const DAY_MARKER = /^\s*<b>(\d{1,2}) :<\/b>/;
const INVADER_ANCHOR = /<a href='javascript:lienm\("([A-Z][A-Z0-9]*)",\s*(\d+)\);' class='(\w+)'>([^<]+)<\/a>/g;

const KIND_BY_VERB: ReadonlyArray<readonly [RegExp, NewsEventKind]> = [
  [/destruction/i, "destruction"],
  [/d[ée]gradation/i, "degradation"],
  [/r[ée]activation/i, "reactivation"],
  [/restauration/i, "restoration"],
  [/ajout/i, "addition"],
  [/alerte/i, "alert"],
];

function verbKindIn(segment: string): NewsEventKind | null {
  let found: { index: number; kind: NewsEventKind } | null = null;
  for (const [verb, kind] of KIND_BY_VERB) {
    const match = new RegExp(verb.source, "gi");
    let last: RegExpExecArray | null = null;
    for (let hit = match.exec(segment); hit; hit = match.exec(segment)) last = hit;
    if (last && (!found || last.index > found.index)) found = { index: last.index, kind };
  }
  return found?.kind ?? null;
}

function kindFromCssClass(cssClass: string): NewsEventKind {
  if (cssClass === "ko") return "destruction";
  if (cssClass === "dg") return "degradation";
  if (cssClass === "wn") return "alert";
  return "status_update";
}

function kindFor(precedingHtml: string, inheritedKind: NewsEventKind | null, cssClass: string): NewsEventKind {
  return verbKindIn(stripTags(precedingHtml)) ?? inheritedKind ?? kindFromCssClass(cssClass);
}

function isoDate(year: string, month: string, day: string): string {
  return `${year}-${month}-${day.padStart(2, "0")}`;
}

interface ParagraphCursor {
  day: string | null;
  inheritedKind: NewsEventKind | null;
}

function parseParagraph(body: string, year: string, month: string, cursor: ParagraphCursor, events: InvaderNewsEvent[]): void {
  const dayMarker = DAY_MARKER.exec(body);
  if (dayMarker) {
    cursor.day = dayMarker[1]!;
    cursor.inheritedKind = null;
  }
  if (!cursor.day) return;
  const sentence = stripTags(body);
  let segmentStart = 0;
  for (const anchor of body.matchAll(INVADER_ANCHOR)) {
    const [, districtCode, , cssClass, label] = anchor;
    const preceding = body.slice(segmentStart, anchor.index);
    segmentStart = anchor.index + anchor[0].length;
    const id = parseInvaderId(label!);
    if (!id) continue;
    const kind = kindFor(preceding, cursor.inheritedKind, cssClass!);
    cursor.inheritedKind = kind;
    events.push({
      id,
      displayId: formatInvaderId(id),
      cityCode: districtToCityCode(districtCode!),
      districtCode: districtCode!,
      kind,
      date: isoDate(year, month, cursor.day),
      sentence,
    });
  }
}

export function parseNewsPage(html: string): InvaderNewsEvent[] {
  const events: InvaderNewsEvent[] = [];
  const sections = html.split(/(?=<img id='croix\d{6}')/);
  for (const section of sections) {
    const monthMatch = MONTH_SECTION.exec(section);
    if (!monthMatch) continue;
    const [, year, month] = monthMatch;
    const cursor: ParagraphCursor = { day: null, inheritedKind: null };
    for (const paragraph of section.matchAll(NEWS_PARAGRAPH)) {
      parseParagraph(paragraph[1]!, year!, month!, cursor, events);
    }
  }
  return events;
}
