import axios from "axios";
import { withRetry } from "@flashcastr/resilience";
import { ProxyRotator } from "@flashcastr/proxy";
import type { DownloadedImage, ImageSource } from "./imageSource.js";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
];

function getRealisticHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
  };
}

export interface AxiosImageSourceOptions {
  readonly proxyRotator?: ProxyRotator;
}

export class AxiosImageSource implements ImageSource {
  private readonly proxyRotator: ProxyRotator;

  constructor(options: AxiosImageSourceOptions = {}) {
    this.proxyRotator = options.proxyRotator ?? new ProxyRotator();
  }

  async download(imageUrl: string): Promise<DownloadedImage> {
    const headers = getRealisticHeaders();
    const { agent, proxy } = this.proxyRotator.createAgent(imageUrl);
    const agentOption = agent ? (imageUrl.startsWith("https://") ? { httpsAgent: agent } : { httpAgent: agent }) : {};

    try {
      const response = await withRetry(
        () => axios.get<ArrayBuffer>(imageUrl, {
          responseType: "arraybuffer",
          headers,
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: (status) => status < 400,
          ...agentOption,
        }),
        { maxAttempts: 4, baseDelayMs: 1000, jitterMs: 1000 }
      );
      return { data: response.data, contentType: String(response.headers["content-type"] ?? "image/jpeg") };
    } catch (error) {
      if (proxy) this.proxyRotator.markFailed(proxy);
      throw error;
    }
  }
}
