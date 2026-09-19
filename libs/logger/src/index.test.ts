import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

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

  it("does not throw on a circular-reference object arg", () => {
    const { destination } = captureLines();
    const log = createLogger("api", destination);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => log.info("weird", circular)).not.toThrow();
  });
});
