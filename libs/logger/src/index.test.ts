import { describe, expect, it } from "vitest";
import { closeLoggers, createLogger } from "./index.js";

function countActiveTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => resolve()));
}

function captureLines() {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk.toString());
      return true;
    },
  };
  return { chunks, destination };
}

function parseLines(chunks: string[]): Record<string, unknown>[] {
  return chunks.map((chunk) => JSON.parse(chunk));
}

describe("createLogger", () => {
  it("stamps the service name and a string level on every line", () => {
    const { chunks, destination } = captureLines();
    const log = createLogger("flash-engine", destination);

    log.info("started");

    const [line] = parseLines(chunks);
    expect(line.service).toBe("flash-engine");
    expect(line.level).toBe("info");
    expect(line.msg).toBe("started");
  });

  it("serializes an Error arg under err via pino's default serializer", () => {
    const { chunks, destination } = captureLines();
    const log = createLogger("database-engine", destination);
    const err = new Error("boom");

    log.error("upsert failed:", err);

    const [line] = parseLines(chunks);
    const serializedErr = line.err as { message: string; stack: string };
    expect(serializedErr.message).toBe("boom");
    expect(serializedErr.stack).toContain("at ");
    expect(line.msg).toBe("upsert failed:");
  });

  it("merges a plain object arg onto the log line as top-level fields", () => {
    const { chunks, destination } = captureLines();
    const log = createLogger("neynar-engine", destination);

    log.info("flash stored", { flashId: "abc123" });

    const [line] = parseLines(chunks);
    expect(line.flashId).toBe("abc123");
    expect(line.msg).toBe("flash stored");
  });

  it("suppresses debug lines by default", () => {
    delete process.env.LOG_LEVEL;
    const { chunks, destination } = captureLines();
    const log = createLogger("api", destination);

    log.debug("quiet");

    expect(chunks).toHaveLength(0);
  });

  it("emits debug lines when LOG_LEVEL=debug is set before createLogger", () => {
    process.env.LOG_LEVEL = "debug";
    try {
      const { chunks, destination } = captureLines();
      const log = createLogger("api", destination);

      log.debug("loud");

      const [line] = parseLines(chunks);
      expect(line.level).toBe("debug");
      expect(line.msg).toBe("loud");
    } finally {
      delete process.env.LOG_LEVEL;
    }
  });

  it("serializes an Error nested under a non-err key on a merged object", () => {
    const { chunks, destination } = captureLines();
    const log = createLogger("api", destination);

    log.error("signup failed", { cause: new Error("inner") });

    const [line] = parseLines(chunks);
    const cause = line.cause as { message: string };
    expect(cause.message).toBe("inner");
  });

  it("uses the exact old lowercase level labels for warn and error", () => {
    const { chunks, destination } = captureLines();
    const log = createLogger("api", destination);

    log.warn("careful");
    log.error("broken");

    const [warnLine, errorLine] = parseLines(chunks);
    expect(warnLine.level).toBe("warn");
    expect(errorLine.level).toBe("error");
  });

  it("joins multiple plain args into msg with a space, like the old formatLogArgs", () => {
    const { chunks, destination } = captureLines();
    const log = createLogger("api", destination);

    log.info("a", 1, null);

    const [line] = parseLines(chunks);
    expect(line.msg).toBe("a 1 null");
  });

  it("does not throw on a circular-reference object arg", () => {
    const { destination } = captureLines();
    const log = createLogger("api", destination);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => log.info("weird", circular)).not.toThrow();
  });

  it("builds a Loki-backed logger from LOKI_URL and flushes it cleanly", async () => {
    process.env.LOKI_URL = "https://loki-user:loki-pass@logger-unit-test.invalid:3100";
    try {
      const log = createLogger("api");

      expect(() => log.info("shipped to loki")).not.toThrow();
      await expect(log.flush()).resolves.toBeUndefined();
    } finally {
      delete process.env.LOKI_URL;
    }
  });

  it("closeLoggers releases the Loki batch timer that keeps a short-lived process alive", async () => {
    process.env.LOKI_URL = "https://loki-user:loki-pass@logger-unit-test.invalid:3100";
    try {
      const timersBefore = countActiveTimers();
      createLogger("migrate");
      await settle();

      expect(countActiveTimers()).toBeGreaterThan(timersBefore);

      await closeLoggers();
      await settle();

      expect(countActiveTimers()).toBe(timersBefore);
    } finally {
      delete process.env.LOKI_URL;
    }
  });

  it("closeLoggers resolves when no Loki logger was ever created", async () => {
    await expect(closeLoggers()).resolves.toBeUndefined();
  });
});
