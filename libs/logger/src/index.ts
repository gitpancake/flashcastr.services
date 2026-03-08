const LOKI_URL = process.env.LOKI_URL;
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
  if (flushTimer || !LOKI_URL) return;
  flushTimer = setInterval(flushToLoki, BATCH_INTERVAL_MS);
  // Don't let the timer keep the process alive
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

async function flushToLoki() {
  if (batchBuffer.length === 0 || !LOKI_URL) return;

  const streams = batchBuffer;
  batchBuffer = [];

  try {
    const res = await fetch(`${LOKI_URL}/loki/api/v1/push`, {
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
  } catch {
    // Silently drop — don't crash the service over logging
  }
}

function pushToLoki(
  serviceName: string,
  level: LogLevel,
  message: string
) {
  if (!LOKI_URL) return;

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
if (LOKI_URL) {
  process.on("beforeExit", () => {
    flushToLoki();
  });
}

export type Logger = ReturnType<typeof createLogger>;
