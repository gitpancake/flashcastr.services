import axios from "axios";
import { ProxyRotator } from "@flashcastr/proxy";
import { createLogger } from "@flashcastr/logger";
import { withRetry } from "@flashcastr/resilience";

const log = createLogger("flash-engine");

export interface FlashInvaderFlash {
  flash_id: number;
  img: string;
  city: string;
  text: string;
  player: string;
  timestamp: number;
  flash_count: string;
}

export interface FlashInvaderResponse {
  flash_count: string;
  player_count: string;
  with_paris: FlashInvaderFlash[];
  without_paris: FlashInvaderFlash[];
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
];

const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-US,en;q=0.9,fr;q=0.8",
  "en-US,en;q=0.9,es;q=0.8",
];

const NEW_SESSION_WINDOW_MS = 60000;
const FAILURES_BEFORE_SESSION_RESET = 5;

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default class SpaceInvadersAPI {
  private readonly API_URL = "https://api.space-invaders.com";
  private lastRequestTime = 0;
  private sessionStartTime = Date.now();
  private requestCount = 0;
  private consecutiveFailures = 0;
  private readonly proxyRotator = new ProxyRotator();

  private getRandomHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": randomItem(USER_AGENTS),
      Accept: "application/json, text/plain, */*",
      "Accept-Language": randomItem(ACCEPT_LANGUAGES),
      "Accept-Encoding": "gzip, deflate, br",
    };

    if (Math.random() < 0.8) headers["Connection"] = "keep-alive";
    if (Math.random() < 0.4) headers["DNT"] = "1";

    return headers;
  }

  private async humanDelay(): Promise<void> {
    const now = Date.now();
    const isNewSession = now - this.sessionStartTime < NEW_SESSION_WINDOW_MS;

    const minDelay = isNewSession ? 3000 : 1500;
    const maxDelay = isNewSession ? 8000 : 5000;

    if (now - this.lastRequestTime < minDelay) {
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  /** Resolves with the API payload; rethrows after failure bookkeeping so callers can count errors. */
  async getFlashes(): Promise<FlashInvaderResponse> {
    try {
      await this.humanDelay();

      const headers = this.getRandomHeaders();
      const { agent } = this.proxyRotator.createAgent(this.API_URL);

      const requestInstance = axios.create({
        baseURL: this.API_URL,
        headers,
        timeout: Math.floor(Math.random() * 7000) + 8000,
        ...(agent ? { httpsAgent: agent } : {}),
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
      });

      const response = await withRetry(
        () => requestInstance.get<FlashInvaderResponse>("/flashinvaders/flashes/"),
        { maxAttempts: 3, baseDelayMs: 1500, jitterMs: 2000 }
      );

      this.consecutiveFailures = 0;
      return response.data;
    } catch (error: unknown) {
      this.consecutiveFailures++;
      const message = error instanceof Error ? error.message : "Unknown error";
      log.warn(`Failed to fetch flashes (failures: ${this.consecutiveFailures}): ${message}`);

      if (this.consecutiveFailures > FAILURES_BEFORE_SESSION_RESET) {
        this.sessionStartTime = Date.now();
        this.requestCount = 0;
        this.consecutiveFailures = 0;
      }

      throw error;
    }
  }
}
