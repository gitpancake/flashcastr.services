import { cityNameFor, districtToCityCode } from "./cityCodes.js";
import { decodeEntities, stripTags } from "./htmlText.js";
import { formatInvaderId, parseInvaderId } from "./invaderId.js";
import { INVADER_SPOTTER_ORIGIN } from "./invaderSpotterSession.js";
import { conditionFromFrench, type InvaderStatus, type SpotterComment } from "./invaderStatus.js";

const RESULT_BLOCK = /<tr class="haut">([\s\S]*?)(?=<tr class="haut">|<\/table>)/g;
const HEADLINE = /<b>([A-Z][A-Z0-9]*_\d+) \[(\d+|\?+) pts\]<\/b>/;
const INSTALLED = /Date de pose : ([^<]+)</;
const DISTRICT = /lienv\("([A-Z]+)","(\d+)"\);'>([^<]+)<\/a>/;
const CONDITION = /Dernier &eacute;tat connu : <img[^>]*> ([^<]+)</;
const REPORTED = /Date et source : ([^<]+)</;
const CLOSE_UP = /<img src="(grosplan\/[^"]+)"/;
const PHOTO = /href='(photos\/[^']+)'/g;
const COMMENT = /<div id='mess\d+'><p><b><u>([^<]+)<\/u><\/b> \(([^)]+)\) :<br\/>([\s\S]*?)<\/p>/g;
const MAX_COMMENTS = 3;

function absoluteUrl(path: string): string {
  return `${INVADER_SPOTTER_ORIGIN}/${path}`;
}

function parseComments(block: string): SpotterComment[] {
  const comments: SpotterComment[] = [];
  for (const match of block.matchAll(COMMENT)) {
    const [, author, date, body] = match;
    comments.push({ author: decodeEntities(author!), date: date!, text: stripTags(body!) });
  }
  return comments.slice(-MAX_COMMENTS);
}

function parseDistrict(block: string): { cityCode: string; label: string } | null {
  const match = DISTRICT.exec(block);
  if (!match) return null;
  return { cityCode: match[1]!, label: stripTags(match[3]!) };
}

function firstGroup(pattern: RegExp, block: string): string | null {
  const match = pattern.exec(block);
  return match?.[1] ? decodeEntities(match[1].trim()) : null;
}

function parseBlock(block: string, fetchedAt: string): InvaderStatus | null {
  const headline = HEADLINE.exec(block);
  if (!headline) return null;
  const id = parseInvaderId(headline[1]!);
  if (!id) return null;
  const district = parseDistrict(block);
  const { condition, conditionLabel } = conditionFromFrench(firstGroup(CONDITION, block) ?? "");
  const cityCode = district ? districtToCityCode(district.cityCode) : id.cityCode;
  const closeUp = firstGroup(CLOSE_UP, block);
  return {
    id,
    displayId: formatInvaderId(id),
    cityCode,
    cityName: cityNameFor(cityCode),
    district: district?.label ?? null,
    points: /^\d+$/.test(headline[2]!) ? Number(headline[2]) : null,
    installedOn: firstGroup(INSTALLED, block),
    condition,
    conditionLabel,
    conditionReportedAt: firstGroup(REPORTED, block),
    closeUpImageUrl: closeUp ? absoluteUrl(closeUp) : null,
    photoUrls: [...block.matchAll(PHOTO)].map((match) => absoluteUrl(match[1]!)),
    recentComments: parseComments(block),
    sourceUrl: `${INVADER_SPOTTER_ORIGIN}/cherche.php`,
    fetchedAt,
  };
}

export function parseListingPage(html: string, fetchedAt: string): InvaderStatus[] {
  const statuses: InvaderStatus[] = [];
  for (const match of html.matchAll(RESULT_BLOCK)) {
    const status = parseBlock(match[1]!, fetchedAt);
    if (status) statuses.push(status);
  }
  return statuses;
}
