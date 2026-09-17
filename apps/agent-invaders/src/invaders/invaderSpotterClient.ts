import { searchFormCodesFor } from "./cityCodes.js";
import { formatInvaderId, type InvaderId } from "./invaderId.js";
import type { SpotterFetch } from "./invaderSpotterSession.js";
import type { InvaderStatus } from "./invaderStatus.js";
import { parseListingPage } from "./listingPageParser.js";
import { parseNewsPage, type InvaderNewsEvent } from "./newsPageParser.js";

const ALL_CONDITIONS = ["ok", "peudegrade", "degrade", "tresdegrade", "detruit", "nonvisible", "inconnu"];
const ALL_POINTS = ["10pts", "20pts", "30pts", "40pts", "50pts", "100pts", "inconnupts"];

export interface InvaderStatusLookup {
  lookupStatuses(ids: readonly InvaderId[]): Promise<InvaderStatus[]>;
}

export interface InvaderNewsFeed {
  fetchNewsEvents(): Promise<InvaderNewsEvent[]>;
}

export class InvaderSpotterClient implements InvaderStatusLookup, InvaderNewsFeed {
  constructor(private readonly session: SpotterFetch, private readonly clock: () => Date = () => new Date()) {}

  async fetchNewsEvents(): Promise<InvaderNewsEvent[]> {
    const html = await this.session.get("news.php");
    return parseNewsPage(html);
  }

  async lookupStatuses(ids: readonly InvaderId[]): Promise<InvaderStatus[]> {
    const byCity = new Map<string, InvaderId[]>();
    for (const id of ids) {
      const group = byCity.get(id.cityCode) ?? [];
      group.push(id);
      byCity.set(id.cityCode, group);
    }
    const statuses: InvaderStatus[] = [];
    for (const [cityCode, group] of byCity) {
      statuses.push(...(await this.lookupCity(cityCode, group)));
    }
    return statuses;
  }

  private async lookupCity(cityCode: string, ids: readonly InvaderId[]): Promise<InvaderStatus[]> {
    const form = new URLSearchParams();
    for (const code of searchFormCodesFor(cityCode)) form.set(code, "on");
    form.set("numero", ids.map((id) => String(id.number)).join("; "));
    for (const condition of ALL_CONDITIONS) form.set(condition, "on");
    for (const points of ALL_POINTS) form.set(points, "on");
    const html = await this.session.postForm("listing.php", "cherche.php", form);
    const wanted = new Set(ids.map(formatInvaderId));
    return parseListingPage(html, this.clock().toISOString()).filter((status) => wanted.has(status.displayId));
  }
}
