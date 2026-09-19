# flashcastr.services

npm-workspaces monorepo: 4 pipeline engines, 1 GraphQL API, 1 LangGraph agent, 11 shared libs.

## Workspace

- `apps/` — flash-engine, image-engine, database-engine, neynar-engine, api, agent-invaders (own `CLAUDE.md`, no lib imports)
- `libs/` — shared-types, rabbitmq, database, proxy, metrics, health, logger, crypto, config, resilience, runtime
- Imports use `@flashcastr/<lib>`; resolved from source via the `@flashcastr/source` exports condition. Dev/droplet run under `tsx` directly, no build step; Docker images for the 5 Railway apps bundle with esbuild (see Deployment).
- `scripts/` — `replay-dead-letters.ts` (DLQ → original routing key), `migrate-old-queue.ts` (one-off)

## Stack

Node 22 (`node:22-slim`, engines `>=22`), TypeScript strict `nodenext`, RabbitMQ (`amqplib` 2, topic exchange `flashcastr.events`, DLX `flashcastr.dlx`), Postgres (`pg`), Pinata, Neynar SDK, Apollo Server 5 + `@as-integrations/express4` + graphql-ws 6, prom-client, OpenTelemetry 2.x (api only), Loki shipping via `@flashcastr/logger`.

## Commands

```bash
npm install
npm run typecheck          # tsc over apps/, libs/, scripts/ (what CI runs)
npm test                   # vitest: libs/*/src/**/*.test.ts, apps/*/src/**/*.test.ts, apps/*/tests/**
npx tsx --watch apps/<service>/src/main.ts
npx tsx scripts/replay-dead-letters.ts --dry-run [--limit N] [--only flash.received]
docker-compose up
```

Lockfile: regenerate with `npx npm@10 install --package-lock-only` after dependency changes; the node image's npm ci rejects npm 11 lockfiles.

## Message Flow

```
flash-engine --flash.received--> image-engine --image.pinned--> database-engine --flash.stored--> neynar-engine --flash.casted--> api (graphql subscriptions)
```

`flash.casted` has no dedicated durable queue for neynar-engine's own publish — its only consumer is each running `api` instance's per-replica exclusive, auto-delete queue (see Reliability contract below), which also binds `flash.stored`.

Envelope: `MessageEnvelope<T>` (`id`, `correlationId`, `source`, `type`, `version`, `timestamp`, `payload`). Publisher sets AMQP `messageId = envelope.id`.

## Reliability contract (libs/rabbitmq)

- **Publisher** uses a confirm channel; `publish()` resolves only on broker ack, rejects on nack or after `confirmTimeoutMs` (10s). Reconnects lazily.
- **Consumer** (`FlashcastrConsumer`, Template Method): subclasses implement `handleMessage`; failures go through one policy:
  - `TransientError(msg, retryAfterMs)` → sleep, requeue, no attempt consumed (image-engine uses it while the IPFS circuit is open).
  - `FatalMessageError` or `shouldRequeueOnFailure() === false` → dead-letter immediately.
  - otherwise → exponential backoff (1s→30s) and requeue until `maxAttempts` (default 5, env `CONSUMER_MAX_ATTEMPTS`; image-engine 10), then dead-letter.
  - Malformed / non-envelope bodies → dead-letter.
  - Attempts are tracked in-process by `messageId` (requeue does not add `x-death`).
- `manualAck: true` (database-engine) hands `ack/requeue/deadLetter` to the handler; settles are ignored if the delivery channel has been replaced (broker redelivers).
- `exclusive: { bindings: string[] }` (api's `SubscriptionConsumer` only) skips the fixed durable queue: `assertQueue("", { exclusive: true, autoDelete: true })` per connect/reconnect, bound to the given routing keys on `EXCHANGES.EVENTS`. Every api replica gets its own queue and sees every event; nothing buffers across a restart or reconnect.
- Recovers from connection close, channel close, and broker-side consumer cancel; connect races a 20s handshake deadline.
- `isConsuming()` feeds `/health`; `observeQueueDepths()` exports `rabbitmq_queue_messages{queue}` incl. `flashcastr.dead-letters`.
- Queue args (`x-max-length: 100000`, DLX) cannot change without recreating queues; overflow is drop-head → dead-lettered. Nothing consumes the DLQ: watch the gauge, replay with the script.

## Engine specifics

- **database-engine**: batches (`BATCH_SIZE`, `BATCH_FLUSH_INTERVAL_MS`) and acks only after the upsert AND the confirmed `flash.stored` publish; either failing requeues after `BATCH_RETRY_DELAY_MS`. Prefetch is forced to ≥ 2×BATCH_SIZE.
- **image-engine**: `CircuitBreaker` (30 consecutive pin failures → open 5 min → half-open single trial). Download/pin retries via `withRetry`. `CONSUMER_RATE_LIMIT` req/min.
- **neynar-engine**: user lookup by username; casts built by `buildFlashCast`; retry worker every `RETRY_INTERVAL_MS` disables `auto_cast` on revoked/403.
- **flash-engine**: croner (`CRON_SCHEDULE`, `protect: true`), peak hours in `Europe/Paris`, in-memory `recentFlashIds` dedupe (restart re-publishes; downstream is idempotent). Reads registered players from Postgres at boot and on a periodic refresh loop (default every 5 min), with a refresh-if-stale check before each poll; exits if the initial Postgres load fails.
- **api**: `withApiKey` (constant-time, `x-api-key`) on `setUserAutoCast`/`deleteUser`; `withRateLimit` per client IP on `initiateSignup` (creates a Neynar-sponsored signer, billed in credits) and `saveFlashIdentification`. `WhereBuilder` + `clampLimit` (max 500) for list queries; `createCache` keyed by args. Subscriptions bridge through `SubscriptionConsumer`. `/health` = Postgres (503 on error) + subscription consumer state. Tracing preloaded via `instrumentation.ts` then `server.ts` is dynamically imported.

## Process lifecycle (libs/runtime)

`runService(name, { registry, metricsPort, healthChecks, start })`: serves `/metrics` + `/health` (503 only on `error`), runs `onShutdown` steps in reverse on SIGINT/SIGTERM, flushes Loki, exits 1 on unhandled rejection/exception. Register shutdown steps outermost-first (pool, publisher, consumer).

## Database

| Table | Notes |
|-------|-------|
| `flashes` | upsert on `flash_id`, `ipfs_cid` only ever overwritten with a non-empty value |
| `flashcastr_flashes` | `cast_hash NULL` = pending retry; has `deleted` |
| `flashcastr_users` | encrypted `signer_uuid` (AES-256-GCM, `SIGNER_ENCRYPTION_KEY`), `auto_cast`, `deleted`. Deletes are hard (`deleteWithFlashes` transaction); `deleted=false` filters are legacy but kept everywhere |
| `flash_identifications` | upsert on `source_ipfs_cid` |

No schema source in repo; tables pre-exist in Railway Postgres.

## Deployment

- Railway (Dockerfile per app, auto-deploy on main): flash-engine, database-engine, neynar-engine, api, agent-invaders. Railway service settings own Dockerfile path/watch patterns.
- Those 5 Dockerfiles are multi-stage: builder runs `npm ci` + `esbuild src/main.ts --bundle --platform=node --format=esm --target=node22` with `pg`/`amqplib`/`@neynar/nodejs-sdk` (and `@opentelemetry/*` for api) marked `--external`; a generated minimal `package.json` installs just those externals into the runtime stage, which copies only that `node_modules` + the bundle — no `libs/`, no source, no dev deps. agent-invaders imports no `@flashcastr/*` lib, so its Dockerfile skips the `libs/` COPY entirely.
- image-engine's Dockerfile stays tsx-based (droplet is its real deploy path, see below); only used locally via `docker-compose up`.
- DigitalOcean droplet via `deploy-image-engine.yml` (ssh + pm2): image-engine. The droplet's Node must be ≥22.
- CI: `npm run typecheck` + `npm test` on push/PR (no Docker build in CI).

## Env

See `.env.example`. Hardening knobs: `API_KEY`, `TRUST_PROXY_HOPS`, `RATE_LIMIT_SIGNUP_PER_10MIN`, `RATE_LIMIT_IDENTIFICATION_PER_MIN`, `CORS_ORIGINS`, `GRAPHQL_INTROSPECTION`, `CONSUMER_MAX_ATTEMPTS`, `BATCH_RETRY_DELAY_MS`, `TRENDING_CACHE_TTL_MS`.

## Gotchas

- Frontend calls `initiateSignup`, `pollSignupStatus`, `saveFlashIdentification` from the browser with no key; never put `withApiKey` on them.
- `flashcastr_flashes.deleted` / `flashcastr_users.deleted` exist but nothing sets them true anymore.
- `getFid()` (api) is memoized per process; the developer mnemonic is only read there.
- Neynar `PostCastReqBodyEmbeds` types every embed field as required; `buildFlashCast` casts a url-only embed.
- Prometheus `operation_name` label is the schema root field, not the client operation name.
- esbuild's CJS interop shim for `dotenv`'s internal `require("fs")` throws `Dynamic require of "fs" is not supported` under plain `--format=esm` output; the Docker builder stages carry a `--banner:js` injecting `createRequire(import.meta.url)` to fix it. Any new bundled app needs the same banner.
