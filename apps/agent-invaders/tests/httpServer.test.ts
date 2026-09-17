import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/inbound/httpServer.js";
import type { InboundDispatcher } from "../src/inbound/inboundDispatcher.js";

function buildApp(dispatch = vi.fn()) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  const dispatcher = { dispatch } as unknown as InboundDispatcher;
  const digestCommand = { execute: vi.fn(async () => undefined) };
  return { app: createApp({ port: 0, webhookSecret: "s3cret", adminToken: "admin", dispatcher, digestCommand, logger, clock: () => new Date("2026-09-16T10:00:00Z") }), dispatch, digestCommand };
}

const castEvent = {
  type: "cast.created",
  data: { hash: "0xabc", thread_hash: "0xroot", parent_hash: null, text: "@flashcastr how's PA_04 doing?", author: { fid: 42, username: "hunter" } },
};

function signed(body: string) {
  return { "x-neynar-signature": createHmac("sha512", "s3cret").update(body).digest("hex"), "content-type": "application/json" };
}

describe("http server", () => {
  it("dispatches a signed cast.created event as a mention", async () => {
    const { app, dispatch } = buildApp();
    const body = JSON.stringify(castEvent);
    const response = await app.request("/webhooks/neynar", { method: "POST", body, headers: signed(body) });
    expect(response.status).toBe(200);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ hash: "0xabc", threadHash: "0xroot", kind: "mention", authorFid: 42, castAt: "2026-09-16T10:00:00.000Z", receivedAt: "2026-09-16T10:00:00.000Z" }));
  });

  it("rejects an unsigned webhook", async () => {
    const { app, dispatch } = buildApp();
    const response = await app.request("/webhooks/neynar", { method: "POST", body: JSON.stringify(castEvent) });
    expect(response.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores other event types", async () => {
    const { app, dispatch } = buildApp();
    const body = JSON.stringify({ type: "reaction.created" });
    const response = await app.request("/webhooks/neynar", { method: "POST", body, headers: signed(body) });
    expect(response.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("guards the manual digest trigger with the admin token", async () => {
    const { app, digestCommand } = buildApp();
    expect((await app.request("/admin/digest", { method: "POST" })).status).toBe(401);
    const response = await app.request("/admin/digest", { method: "POST", headers: { authorization: "Bearer admin" } });
    expect(response.status).toBe(200);
    expect(digestCommand.execute).toHaveBeenCalled();
  });
});
