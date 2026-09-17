export const INVADER_SPOTTER_ORIGIN = "https://www.invader-spotter.art";

const USER_AGENT = "Mozilla/5.0 (compatible; flashcastr-agent/0.1; +https://www.flashcastr.app)";

export interface SpotterFetch {
  get(path: string): Promise<string>;
  postForm(path: string, referer: string, body: URLSearchParams): Promise<string>;
}

export class InvaderSpotterSession implements SpotterFetch {
  private cookieHeader: string | null = null;

  constructor(private readonly origin: string = INVADER_SPOTTER_ORIGIN) {}

  async get(path: string): Promise<string> {
    const response = await fetch(`${this.origin}/${path}`, { headers: this.headers() });
    this.rememberCookies(response);
    if (!response.ok) throw new Error(`invader-spotter GET ${path} → ${response.status}`);
    return response.text();
  }

  async postForm(path: string, referer: string, body: URLSearchParams): Promise<string> {
    await this.ensureCookie(referer);
    const response = await fetch(`${this.origin}/${path}`, {
      method: "POST",
      headers: {
        ...this.headers(),
        Referer: `${this.origin}/${referer}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    this.rememberCookies(response);
    if (!response.ok) throw new Error(`invader-spotter POST ${path} → ${response.status}`);
    return response.text();
  }

  private async ensureCookie(path: string): Promise<void> {
    if (this.cookieHeader) return;
    await this.get(path);
  }

  private headers(): Record<string, string> {
    const base: Record<string, string> = { "User-Agent": USER_AGENT, "Accept-Language": "fr,en;q=0.8" };
    if (this.cookieHeader) base.Cookie = this.cookieHeader;
    return base;
  }

  private rememberCookies(response: Response): void {
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length === 0) return;
    const pairs = setCookies.map((cookie) => cookie.split(";")[0]!.trim()).filter(Boolean);
    this.cookieHeader = pairs.join("; ");
  }
}
