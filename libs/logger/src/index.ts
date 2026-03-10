function getLokiUrl(): string | undefined {
  return process.env.LOKI_URL;
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
  flushTimer = setInterval(flushToLoki, BATCH_INTERVAL_MS);
  // Don't let the timer keep the process alive
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

async function flushToLoki() {
  if (batchBuffer.length === 0 || !getLokiUrl()) return;

  const streams = batchBuffer;
  batchBuffer = [];

  try {
    const res = await fetch(`${getLokiUrl()}/loki/api/v1/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streams }),
    });
    if (!res.ok) {
      // Log to stderr only to avoid infinite loop
      process.stderr.write(
        `[logger] Loki push failed: ${res.status} ${res.statusText}\n`
      );
    }
  } catch (err) {
    process.stderr.write(
      `[logger] Loki fetch error: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

let lokiStatusLogged = false;

function pushToLoki(
  serviceName: string,
  level: LogLevel,
  message: string
) {
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
    flushToLoki();
  } else {
    startFlushTimer();
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg) : String(arg)
    )
    .join(" ");
}

export function createLogger(serviceName: string) {
  const prefix = `[${serviceName}]`;

  function log(level: LogLevel, args: unknown[]) {
    const message = formatArgs(args);

    // Always write to stdout/stderr for local dev + Railway log viewer
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

// Flush remaining logs before process exits
process.on("beforeExit", () => {
  if (getLokiUrl()) flushToLoki();
});

export type Logger = ReturnType<typeof createLogger>;
