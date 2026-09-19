import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loki = vi.hoisted(() => {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write(chunk: string) {
        chunks.push(chunk.toString());
        return true;
      },
      end(cb?: () => void) {
        cb?.();
      },
    },
    pinoLoki: vi.fn(),
  };
});
loki.pinoLoki.mockImplementation(() => loki.stream);

vi.mock("pino-loki", () => ({ pinoLoki: loki.pinoLoki }));

import { createLogger } from "./index.js";

function parseLines(chunks: string[]): Record<string, unknown>[] {
  return chunks.map((chunk) => JSON.parse(chunk));
}

describe("createLogger stdout tee", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loki.chunks.length = 0;
    loki.pinoLoki.mockClear();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    delete process.env.LOKI_URL;
  });

  it("writes to stdout when LOKI_URL is unset", () => {
    const log = createLogger("flash-engine");

    log.info("started");

    const lines = parseLines(stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])));
    expect(lines.some((line) => line.msg === "started")).toBe(true);
    expect(loki.pinoLoki).not.toHaveBeenCalled();
  });

  it("tees the same line to both stdout and loki when LOKI_URL is set", async () => {
    process.env.LOKI_URL = "https://loki-user:loki-pass@logger-unit-test.invalid:3100";
    const log = createLogger("api");

    log.info("shipped");

    const stdoutLines = parseLines(stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])));
    const lokiLines = parseLines(loki.chunks);
    expect(stdoutLines.some((line) => line.msg === "shipped")).toBe(true);
    expect(lokiLines.some((line) => line.msg === "shipped")).toBe(true);

    await log.flush();
  });

  it("keeps the injected-destination path bypassing both stdout and loki", () => {
    const chunks: string[] = [];
    const destination = {
      write(chunk: string) {
        chunks.push(chunk.toString());
        return true;
      },
    };
    const log = createLogger("api", destination);

    log.info("direct");

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(loki.pinoLoki).not.toHaveBeenCalled();
    expect(parseLines(chunks).some((line) => line.msg === "direct")).toBe(true);
  });
});
