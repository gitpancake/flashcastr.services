/**
 * Scrapes invader-spotter.art/news.php for mosaic events.
 * Parses the HTML news feed into structured events (destructions,
 * reactivations, new installations, etc.) with invader IDs and cities.
 *
 * NOTE: invader-spotter.art uses district-level city codes for Paris:
 * PA01–PA20, PA92, PA94, etc. The lienm() JS calls use these district codes
 * (e.g. lienm("PA05",213)) but the canonical invader ID displayed in the link
 * text is always the simple form (PA_213). We extract IDs from link text and
 * strip trailing digits from codes to get the base city (PA05 → PA).
 */

const NEWS_URL = 'https://www.invader-spotter.art/news.php';

export interface ScrapedEvent {
  invaderId: string;      // e.g. PA_1099
  city: string;           // e.g. PA
  eventType: string;      // destruction, degradation, reactivation, restoration, status_update, addition, alert
  eventDate: string;      // YYYY-MM-DD
  rawText: string;        // original line from the news feed
}

// Maps the CSS status class used on anchor tags to normalized English types.
// ok = active (reactivation, restoration, or new addition)
// ko = destroyed/inactive
// dg = degraded
// wn = alert/warning
// nt = neutral/status update
//
// For class='ok', we distinguish addition vs reactivation vs restoration by
// checking for unencoded ASCII keywords in the surrounding text (these words
// have no accents, so they survive HTML encoding unchanged).
const CSS_CLASS_MAP: Record<string, string> = {
  ko: 'destruction',
  dg: 'degradation',
  wn: 'alert',
  nt: 'status_update',
};

/**
 * Fetch and parse the invader-spotter.art news page.
 * Returns structured events sorted newest first.
 */
export async function scrapeInvaderNews(): Promise<ScrapedEvent[]> {
  const response = await fetch(NEWS_URL, {
    headers: { 'User-Agent': 'LifeOS-Flashcastr/1.0 (invader content agent)' },
  });
  if (!response.ok) throw new Error(`invader-spotter.art returned ${response.status}`);
  const html = await response.text();
  return parseNewsHtml(html);
}

/**
 * Parse the raw HTML into structured events.
 *
 * The page has monthly sections with entries like:
 *   "14 : Destruction de PA_1099. Dégradation de FTBL_46."
 *
 * Month/year is extracted from the section div IDs (id='croix202604') which
 * are reliable and entity-free. Falling back to the French month text would
 * fail for months with accented chars (f&eacute;vrier, d&eacute;cembre, ao&ucirc;t).
 */
export function parseNewsHtml(html: string): ScrapedEvent[] {
  const events: ScrapedEvent[] = [];
  let currentYear = new Date().getFullYear().toString();
  let currentMonth = '01';

  const lines = html.split('\n');

  for (const line of lines) {
    // Check for month/year section header via the croix element ID: id='croix202604'
    // This is always on the same line as the month label and never HTML-encoded.
    const sectionMatch = line.match(/id='croix(\d{4})(\d{2})'/);
    if (sectionMatch) {
      currentYear = sectionMatch[1]!;
      currentMonth = sectionMatch[2]!;
    }

    // Check for day entries: "14 :" pattern
    const dayMatch = line.match(/(?:^|>)\s*(\d{1,2})\s*:/);
    if (!dayMatch) continue;

    const day = dayMatch[1].padStart(2, '0');
    const eventDate = `${currentYear}-${currentMonth}-${day}`;

    // Canonical invader ID comes from link text (PA_213), not the lienm() arg
    // (PA05) — district codes would produce wrong IDs like PA05_213.
    const anchorPattern = /href='javascript:lienm\("([A-Z][A-Z0-9]*)",\s*\d+\)[^']*'\s+class='(\w+)'>([^<]+)<\/a>/g;
    let anchorMatch;
    const invaderRefs: { id: string; city: string; cssClass: string; position: number }[] = [];

    while ((anchorMatch = anchorPattern.exec(line)) !== null) {
      const districtCode = anchorMatch[1]!;
      const cssClass = anchorMatch[2]!;
      const displayId = anchorMatch[3]!.trim();
      // Strip trailing digits to get base city code: PA05 → PA, LDN → LDN
      const baseCityCode = districtCode.replace(/\d+$/, '');
      invaderRefs.push({
        id: displayId,
        city: baseCityCode,
        cssClass,
        position: anchorMatch.index,
      });
    }

    if (invaderRefs.length === 0) continue;

    const cleanLine = line.replace(/<[^>]+>/g, ' ');

    for (const ref of invaderRefs) {
      let eventType = CSS_CLASS_MAP[ref.cssClass] ?? 'status_update';

      // 'ok' spans three event types; Ajout/Restauration are ASCII so they
      // survive HTML entity encoding and can be used as disambiguators.
      if (ref.cssClass === 'ok') {
        const textBefore = line.slice(Math.max(0, ref.position - 200), ref.position);
        if (textBefore.includes('Ajout')) {
          eventType = 'addition';
        } else if (textBefore.includes('Restauration')) {
          eventType = 'restoration';
        } else {
          eventType = 'reactivation';
        }
      }

      events.push({
        invaderId: ref.id,
        city: ref.city,
        eventType,
        eventDate,
        rawText: cleanLine.trim().slice(0, 500),
      });
    }
  }

  return events;
}
