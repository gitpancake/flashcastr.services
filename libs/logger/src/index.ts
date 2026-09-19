import pino from "pino";
import { pinoLoki } from "pino-loki";

export type LogLevel = "info" | "warn" | "error" | "debug";

function getLokiUrl(): string | undefined {
  return process.env.LOKI_URL;
}

function parseLokiUrl(raw: string): {
  host: string;
  basicAuth?: { username: string; password: string };
} {
  const parsed = new URL(raw);
  let basicAuth: { username: string; password: string } | undefined;
  if (parsed.username) {
    basicAuth = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }
  return { host: parsed.toString().replace(/\/$/, ""), basicAuth };
}

interface LokiDestination {
  stream: NodeJS.WritableStream;
  flush(): Promise<void>;
}

function createLokiDestination(): LokiDestination | null {
  const raw = getLokiUrl();
  if (!raw) return null;

  const { host, basicAuth } = parseLokiUrl(raw);
  const stream = pinoLoki({
    host,
    basicAuth,
    propsToLabels: ["service", "level"],
    batching: { interval: 2 },
  });

  return {
    stream,
    flush: () => new Promise((resolve) => stream.end(() => resolve())),
  };
}

function serializeErrorValues(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [
      key,
      value instanceof Error ? { message: value.message, stack: value.stack } : value,
    ])
  );
}

function toPinoArgs(args: unknown[]): [Record<string, unknown> | undefined, string] {
  let mergingObject: Record<string, unknown> | undefined;
  const messageParts: string[] = [];

  for (const arg of args) {
    if (arg instanceof Error) {
      mergingObject = { ...mergingObject, err: arg };
    } else if (arg !== null && typeof arg === "object") {
      mergingObject = { ...mergingObject, ...serializeErrorValues(arg as Record<string, unknown>) };
    } else {
      messageParts.push(String(arg));
    }
  }

  return [mergingObject, messageParts.join(" ")];
}

export function createLogger(serviceName: string, destination?: pino.DestinationStream) {
  // Each logger gets its own Loki stream (not a shared/memoized one): flush()
  // ends the stream, and a process can have multiple independent loggers
  // (e.g. api's main.ts and server.ts) whose exit paths aren't coordinated —
  // sharing one stream would let one logger's flush silently kill another's
  // still-in-flight writes.
  const loki = destination ? null : createLokiDestination();
  const pinoLogger = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      base: { service: serviceName },
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    destination ?? (loki ? pino.multistream([{ stream: process.stdout }, { stream: loki.stream }]) : undefined)
  );

  function log(level: LogLevel, args: unknown[]) {
    const [mergingObject, message] = toPinoArgs(args);
    switch (level) {
      case "info":
        mergingObject ? pinoLogger.info(mergingObject, message) : pinoLogger.info(message);
        break;
      case "warn":
        mergingObject ? pinoLogger.warn(mergingObject, message) : pinoLogger.warn(message);
        break;
      case "error":
        mergingObject ? pinoLogger.error(mergingObject, message) : pinoLogger.error(message);
        break;
      case "debug":
        mergingObject ? pinoLogger.debug(mergingObject, message) : pinoLogger.debug(message);
        break;
    }
  }

  return {
    info: (...args: unknown[]) => log("info", args),
    warn: (...args: unknown[]) => log("warn", args),
    error: (...args: unknown[]) => log("error", args),
    debug: (...args: unknown[]) => log("debug", args),
    flush: () => (loki ? loki.flush() : Promise.resolve()),
  };
}

export type Logger = ReturnType<typeof createLogger>;
