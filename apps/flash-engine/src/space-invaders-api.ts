import axios from "axios";
import { ProxyRotator } from "@flashcastr/proxy";

interface FlashInvaderResponse {
  flash_count: string;
  player_count: string;
  with_paris: Array<{
    flash_id: number;
    img: string;
    city: string;
    text: string;
    player: string;
    timestamp: number;
    flash_count: string;
  }>;
  without_paris: Array<{
    flash_id: number;
    img: string;
    city: string;
    text: string;
    player: string;
    timestamp: number;
    flash_count: string;
  }>;
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

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default class SpaceInvadersAPI {
  private readonly API_URL = "https://api.space-invaders.com";
  private lastRequestTime: number = 0;
  private sessionStartTime: number = Date.now();
  private requestCount: number = 0;
  private consecutiveFailures: number = 0;
  private proxyRotator: ProxyRotator;

  constructor() {
    this.proxyRotator = new ProxyRotator();
  }

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
    const sessionAge = now - this.sessionStartTime;
    const isNewSession = sessionAge < 60000;

    const minDelay = isNewSession ? 3000 : 1500;
    const maxDelay = isNewSession ? 8000 : 5000;

    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < minDelay) {
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  private async retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === maxRetries) throw error;
        const delay = Math.pow(1.5, attempt) * 1000 + Math.random() * 2000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Max retries exceeded");
  }

  async getFlashes(): Promise<FlashInvaderResponse | null> {
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

      const response = await this.retryWithBackoff(() =>
        requestInstance.get<FlashInvaderResponse>("/flashinvaders/flashes/")
      );

      this.consecutiveFailures = 0;
      return response.data;
    } catch (error: unknown) {
      this.consecutiveFailures++;
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`Failed to fetch flashes (failures: ${this.consecutiveFailures}): ${message}`);

      if (this.consecutiveFailures > 5) {
        this.sessionStartTime = Date.now();
        this.requestCount = 0;
        this.consecutiveFailures = 0;
      }

      return null;
    }
  }
}
