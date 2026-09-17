function getLokiUrl(): string | undefined {
  return process.env.LOKI_URL;
}

function parseLokiUrl(raw: string): {
  url: string;
  headers: Record<string, string>;
} {
  const parsed = new URL(raw);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (parsed.username) {
    const credentials = Buffer.from(
      `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
    parsed.username = "";
    parsed.password = "";
  }
  return { url: parsed.toString().replace(/\/$/, ""), headers };
}

let lokiConfig: ReturnType<typeof parseLokiUrl> | null = null;

function getLokiConfig() {
  const raw = getLokiUrl();
  if (!raw) return null;
  if (!lokiConfig) lokiConfig = parseLokiUrl(raw);
  return lokiConfig;
}

const BATCH_INTERVAL_MS = 2000;
const BATCH_SIZE_LIMIT = 100;

type LogLevel = "info" | "warn" | "error" | "debug";

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][];
}

let batchBuffer: LokiStream[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function startFlushTimer() {
  if (flushTimer || !getLokiUrl()) return;
  flushTimer = setInterval(() => { void flushToLoki(); }, BATCH_INTERVAL_MS);
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

async function flushToLoki(): Promise<void> {
  const config = getLokiConfig();
  if (batchBuffer.length === 0 || !config) return;

  const streams = batchBuffer;
  batchBuffer = [];

  try {
    const res = await fetch(`${config.url}/loki/api/v1/push`, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ streams }),
    });
    if (!res.ok) {
      process.stderr.write(`[logger] Loki push failed: ${res.status} ${res.statusText}\n`);
    }
  } catch (err) {
    process.stderr.write(`[logger] Loki fetch error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Ship any buffered log lines to Loki. Call before process.exit so the last lines are not lost. */
export async function flushLogs(): Promise<void> {
  await flushToLoki();
}

let lokiStatusLogged = false;

function pushToLoki(serviceName: string, level: LogLevel, message: string) {
  if (!lokiStatusLogged) {
    lokiStatusLogged = true;
    const url = getLokiUrl();
    process.stderr.write(
      `[logger] LOKI_URL ${url ? `set (${url.replace(/\/\/.*@/, "//***@")})` : "NOT SET"}\n`
    );
  }
  if (!getLokiUrl()) return;

  const nanoseconds = `${Date.now()}000000`;

  batchBuffer.push({
    stream: { service: serviceName, level },
    values: [[nanoseconds, message]],
  });

  if (batchBuffer.length >= BATCH_SIZE_LIMIT) {
    void flushToLoki();
  } else {
    startFlushTimer();
  }
}

function describeError(err: Error): string {
  return err.stack ?? `${err.name}: ${err.message}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested) =>
      nested instanceof Error ? { name: nested.name, message: nested.message, stack: nested.stack } : nested
    );
  } catch {
    return String(value);
  }
}

export function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return describeError(arg);
      if (typeof arg === "object") return safeStringify(arg);
      return String(arg);
    })
    .join(" ");
}

export function createLogger(serviceName: string) {
  const prefix = `[${serviceName}]`;

  function log(level: LogLevel, args: unknown[]) {
    const message = formatLogArgs(args);

    switch (level) {
      case "error":
        console.error(prefix, ...args);
        break;
      case "warn":
        console.warn(prefix, ...args);
        break;
      case "debug":
        console.debug(prefix, ...args);
        break;
      default:
        console.log(prefix, ...args);
    }

    pushToLoki(serviceName, level, message);
  }

  return {
    info: (...args: unknown[]) => log("info", args),
    warn: (...args: unknown[]) => log("warn", args),
    error: (...args: unknown[]) => log("error", args),
    debug: (...args: unknown[]) => {
      if (process.env.LOG_LEVEL === "debug") {
        log("debug", args);
      }
    },
  };
}

process.on("beforeExit", () => {
  if (getLokiUrl()) void flushToLoki();
});

export type Logger = ReturnType<typeof createLogger>;
