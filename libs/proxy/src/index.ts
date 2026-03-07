import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";

interface ProxyConfig {
  host: string;
  port: number;
  protocol: "http" | "https";
  auth?: { username: string; password: string };
}

export class ProxyRotator {
  private proxies: ProxyConfig[] = [];
  private currentIndex: number = 0;
  private failureCount: Map<string, number> = new Map();
  private isOxylabs: boolean = false;

  constructor() {
    this.loadFromEnv();
  }

  private loadFromEnv(): void {
    const proxyList = process.env.PROXY_LIST || process.env.FALLBACK_PROXY_LIST;
    if (!proxyList) return;

    try {
      this.proxies = proxyList.split(",").map((str) => {
        const url = new URL(str.trim());
        return {
          host: url.hostname,
          port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 80),
          protocol: url.protocol.replace(":", "") as "http" | "https",
          auth: url.username && url.password
            ? { username: url.username, password: url.password }
            : undefined,
        };
      });

      this.isOxylabs = this.proxies.some(
        (p) => p.host.includes("oxylabs.io") || p.host.includes("pr.oxylabs.io")
      );

      console.log(`Loaded ${this.proxies.length} proxies`);
    } catch (error) {
      console.error("Error parsing proxy list:", error);
    }
  }

  getNextProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) return null;

    if (this.isOxylabs) {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      return proxy;
    }

    let attempts = 0;
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      const key = `${proxy.host}:${proxy.port}`;
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      if ((this.failureCount.get(key) || 0) < 3) return proxy;
      attempts++;
    }

    this.failureCount.clear();
    return this.proxies[0];
  }

  markFailed(proxy: ProxyConfig): void {
    if (this.isOxylabs) return;
    const key = `${proxy.host}:${proxy.port}`;
    this.failureCount.set(key, (this.failureCount.get(key) || 0) + 1);
  }

  createAgent(targetUrl: string): { agent: HttpsProxyAgent<string> | HttpProxyAgent<string> | undefined; proxy: ProxyConfig | null } {
    const proxy = this.getNextProxy();
    if (!proxy) return { agent: undefined, proxy: null };

    const proxyUrl = `${proxy.protocol}://${
      proxy.auth ? `${proxy.auth.username}:${proxy.auth.password}@` : ""
    }${proxy.host}:${proxy.port}`;

    const agent = targetUrl.startsWith("https://")
      ? new HttpsProxyAgent(proxyUrl)
      : new HttpProxyAgent(proxyUrl);

    return { agent, proxy };
  }

  get count(): number {
    return this.proxies.length;
  }
}
