// LOS-546 — request/response RPC over the bus.
//
// Existing event types like LINEAR_TICKET_DETAIL_* and GIT_CONTEXT_* already
// carry a caller-generated id field that the responder echoes back. What was
// missing was a caller-side promise/timeout helper so a publisher can `await`
// a single response keyed by that id.
//
// This module provides that helper and the abstraction it subscribes through.
// `EventSubscriber` is intentionally narrow — a single `subscribe()` that
// returns an unsubscribe handle — so the helper can be unit-tested without a
// real RabbitMQ channel.
//
// Field-name note: the spec proposed `correlationId`. Real life-os payloads
// (LinearTicketDetailRequest, GitContextRequest, etc.) use `requestId`. The
// helper takes a `correlationField` option (default `'correlationId'`) so
// callers using existing events can pass `'requestId'` without renaming
// fields across producers and consumers.

import { v4 as uuid } from 'uuid';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { LifeEvent } from '../events/types.js';
import { createLifeEvent } from '../events/types.js';
import { EXCHANGE_NAME } from '../events/routing-keys.js';
import type { EventPublisher } from '../rabbitmq/publisher.js';

export interface EventSubscriber {
  /** Subscribe to one routing key. Handler is invoked for every matching
   *  event until the returned `unsubscribe()` is called. Errors thrown from
   *  handler are swallowed by the implementation — callers manage their own
   *  error reporting. */
  subscribe(
    routingKey: string,
    handler: (event: LifeEvent) => void,
  ): Promise<{ unsubscribe: () => Promise<void> }>;
}

export interface BusRpcContext {
  publisher: EventPublisher;
  subscriber: EventSubscriber;
  source: string;
}

export interface BusRpcOptions {
  /** Default 10_000. */
  timeoutMs?: number;
  /** Field on request and response payloads carrying the correlation id.
   *  Default `'correlationId'`. Existing events that use `requestId` should
   *  pass `'requestId'`. */
  correlationField?: string;
}

export interface BusRpcArgs<TReq> {
  requestRoutingKey: string;
  responseRoutingKey: string;
  /** Request payload sans the correlation field — the helper injects it. */
  payload: Omit<TReq, 'correlationId' | 'requestId'>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CORRELATION_FIELD = 'correlationId';

/**
 * Publish `requestRoutingKey` with a fresh correlation id, subscribe once to
 * `responseRoutingKey`, resolve on the matching reply, reject on timeout.
 *
 * Concurrency: each call uses its own subscription, so multiple in-flight
 * RPCs never see each other's responses — mismatched ids are dropped at the
 * handler level too as a defensive layer in case a single subscription is
 * shared across calls in future.
 */
export async function busRpc<TReq, TRes>(
  ctx: BusRpcContext,
  args: BusRpcArgs<TReq>,
  opts: BusRpcOptions = {},
): Promise<TRes> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const correlationField = opts.correlationField ?? DEFAULT_CORRELATION_FIELD;
  const correlationId = uuid();

  // Subscribe BEFORE publishing so a fast responder can't beat us. We must
  // await the subscription handle here — `createChannelSubscriber` performs
  // assertQueue + bindQueue inside `subscribe()`, and a synchronous responder
  // (e.g. service-linear running in-process at ~1ms) can otherwise beat the
  // bind and have its message dropped.
  let unsubscribe: (() => Promise<void>) | null = null;
  let settled = false;
  let resolveResponse!: (value: TRes) => void;
  let rejectResponse!: (err: Error) => void;
  const responsePromise = new Promise<TRes>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  const finish = (run: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Fire-and-forget — unsubscribe failures shouldn't block resolution.
    unsubscribe?.().catch(() => undefined);
    run();
  };

  const timer = setTimeout(() => {
    finish(() => rejectResponse(new Error(
      `busRpc timed out after ${timeoutMs}ms waiting for ${args.responseRoutingKey} ` +
      `(request=${args.requestRoutingKey}, ${correlationField}=${correlationId})`,
    )));
  }, timeoutMs);

  try {
    const handle = await ctx.subscriber.subscribe(args.responseRoutingKey, (event) => {
      const payload = event.payload as Record<string, unknown>;
      if (!payload || payload[correlationField] !== correlationId) return;
      finish(() => resolveResponse(payload as TRes));
    });
    unsubscribe = handle.unsubscribe;
  } catch (err) {
    finish(() => rejectResponse(err as Error));
    return responsePromise;
  }

  // Inject correlation id into the request payload.
  const requestPayload = {
    ...args.payload,
    [correlationField]: correlationId,
  } as unknown as TReq;

  try {
    await ctx.publisher.publish(createLifeEvent<TReq>({
      routingKey: args.requestRoutingKey,
      source: ctx.source,
      payload: requestPayload,
    }));
  } catch (err) {
    finish(() => rejectResponse(err as Error));
  }

  return responsePromise;
}

/**
 * Build an `EventSubscriber` backed by an amqplib `ConfirmChannel`. Each
 * `subscribe()` call asserts an exclusive auto-delete queue, binds it to the
 * given routing key, and starts a consumer. `unsubscribe()` cancels the
 * consumer and deletes the queue.
 *
 * Per-call ephemeral queue (rather than one shared long-lived queue) keeps
 * concurrent RPCs strictly isolated and avoids needing to manage a
 * per-process correlation map. RabbitMQ handles cleanup via the queue's
 * `autoDelete` flag if the consumer drops.
 */
export function createChannelSubscriber(channel: ConfirmChannel): EventSubscriber {
  return {
    async subscribe(routingKey, handler) {
      const queue = await channel.assertQueue('', {
        exclusive: true,
        autoDelete: true,
        durable: false,
      });
      await channel.bindQueue(queue.queue, EXCHANGE_NAME, routingKey);
      const { consumerTag } = await channel.consume(queue.queue, (msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
          const event = JSON.parse(msg.content.toString()) as LifeEvent;
          handler(event);
        } catch (err) {
          // Malformed responses shouldn't tear down the consumer — drop and
          // ack. Surface the parse error so debugging an enrichment failure
          // has a signal.
          console.warn(`[bus-rpc] failed to parse response on ${routingKey}:`, err);
        } finally {
          channel.ack(msg);
        }
      });
      return {
        async unsubscribe() {
          try { await channel.cancel(consumerTag); } catch { /* already cancelled */ }
          try { await channel.deleteQueue(queue.queue); } catch { /* already gone */ }
        },
      };
    },
  };
}
