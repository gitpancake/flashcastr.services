import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { inboundCastFrom } from "../farcaster/inboundCast.js";
import { isValidNeynarSignature } from "../farcaster/neynarSignature.js";
import type { Logger } from "../logging/logger.js";
import type { Command } from "./replyCommand.js";
import type { InboundDispatcher } from "./inboundDispatcher.js";

export interface HttpServerOptions {
  readonly port: number;
  readonly webhookSecret: string | undefined;
  readonly adminToken: string | undefined;
  readonly dispatcher: InboundDispatcher;
  readonly digestCommand: Command;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

const MAX_BODY_BYTES = 1_000_000;

interface NeynarCastEvent {
  readonly type?: string;
  readonly data?: {
    readonly hash: string;
    readonly thread_hash?: string | null;
    readonly parent_hash?: string | null;
    readonly text: string;
    readonly author: { readonly fid: number; readonly username?: string | null };
  };
}

export function createApp(options: HttpServerOptions): Hono {
  const clock = options.clock ?? (() => new Date());
  const app = new Hono();

  app.get("/health", (context) => context.json({ ok: true }));

  app.post("/webhooks/neynar", async (context) => {
    if (!options.webhookSecret) return context.text("webhook disabled", 404);
    const rawBody = Buffer.from(await context.req.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) return context.text("payload too large", 413);
    if (!isValidNeynarSignature(rawBody, context.req.header("x-neynar-signature"), options.webhookSecret)) {
      return context.text("invalid signature", 401);
    }
    const event = JSON.parse(rawBody.toString("utf8")) as NeynarCastEvent;
    if (event.type !== "cast.created" || !event.data) return context.text("ignored", 200);
    options.dispatcher.dispatch(inboundCastFrom(event.data, clock().toISOString()));
    return context.text("accepted", 200);
  });

  app.post("/admin/digest", async (context) => {
    if (!options.adminToken) return context.text("admin disabled", 404);
    if (context.req.header("authorization") !== `Bearer ${options.adminToken}`) return context.text("unauthorized", 401);
    void options.digestCommand.execute();
    return context.json({ started: true });
  });

  return app;
}

export function startHttpServer(options: HttpServerOptions): ServerType {
  const app = createApp(options);
  return serve({ fetch: app.fetch, port: options.port }, (info) => options.logger.info({ port: info.port }, "http server listening"));
}
