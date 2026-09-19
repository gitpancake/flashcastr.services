# flashcastr.services

npm-workspaces monorepo: 4 pipeline engines, 1 GraphQL API, 1 LangGraph agent, 12 shared libs.

**Mid-migration (epic `postgres-job-pipeline`):** RabbitMQ is being replaced by a Postgres job table. Done: cast stage on `flash_jobs`, api subscriptions on `LISTEN/NOTIFY`. Still on RabbitMQ: `flash.received` and `image.pinned`. Sections below describe what runs today.

## Workspace

- `apps/` — flash-engine, image-engine, database-engine, neynar-engine, api, agent-invaders (own `CLAUDE.md`, no lib imports)
- `libs/` — shared-types, rabbitmq, jobs, database, proxy, metrics, health, logger, crypto, config, resilience, runtime
- Imports use `@flashcastr/<lib>`; resolved from source via the `@flashcastr/source` exports condition. Dev/droplet run under `tsx` directly, no build step; Docker images for the 5 Railway apps bundle with esbuild (see Deployment).
- `scripts/` — `replay-dead-letters.ts` (DLQ → original routing key), `migrate-old-queue.ts` (one-off)

## Stack

Node 22 (`node:22-slim`, engines `>=22`), TypeScript strict `nodenext`, RabbitMQ (`amqplib` 2, topic exchange `flashcastr.events`, DLX `flashcastr.dlx`), Postgres (`pg`), Pinata, Neynar SDK, Apollo Server 5 + `@as-integrations/express4` + graphql-ws 6, prom-client, OpenTelemetry 2.x (api only), pino + `pino-loki` via `@flashcastr/logger`.

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
flash-engine --flash.received--> image-engine --image.pinned--> database-engine ==cast job (flash_jobs)==> neynar-engine
database-engine --NOTIFY flash_stored--> api          neynar-engine --NOTIFY flash_casted--> api (graphql subscriptions)
```

`-->` is RabbitMQ, `==>` is a `flash_jobs` row. database-engine no longer publishes `flash.stored`; it enqueues a cast job for every flash in its upsert transaction and neynar-engine deletes the job for non-users. neynar-engine keeps its old `database-engine.flash-stored` consumer for one release to drain the queue (it still publishes `flash.casted`, which nothing consumes). The api has no RabbitMQ connection.

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
- `exclusive: { bindings: string[] }` still exists as a consumer option but has no caller since the api moved to `LISTEN/NOTIFY`.
- Recovers from connection close, channel close, and broker-side consumer cancel; connect races a 20s handshake deadline.
- `isConsuming()` feeds `/health`; `observeQueueDepths()` exports `rabbitmq_queue_messages{queue}` incl. `flashcastr.dead-letters`.
- Queue args (`x-max-length: 100000`, DLX) cannot change without recreating queues; overflow is drop-head → dead-lettered. Nothing consumes the DLQ: watch the gauge, replay with the script.

## Job pipeline (libs/jobs + `FlashJobsDb`)

- `flash_jobs (flash_id, stage 'pin'|'cast', attempts, next_attempt_at, last_error, created_at)`, PK `(flash_id, stage)`. A row exists only while work is outstanding; success deletes it.
- `FlashJobsDb.enqueue/complete` take a client so callers put them in their own transaction. `claim` is one statement (`FOR UPDATE SKIP LOCKED` inside it) that bumps `attempts` and sets `next_attempt_at = now() + lease`; no transaction is held during the work, and a crashed worker's job is reclaimed when the lease expires.
- `JobWorker`: N claim loops; `TransientError` → `defer` (attempt handed back), `FatalMessageError` / `shouldRetry === false` → dead, otherwise backoff 1s→30s. `pause()/resume()`, `isRunning()` for `/health`, `close()` waits for in-flight handlers. `TransientError`/`FatalMessageError` live here; `libs/rabbitmq` re-exports them.
- Dead job = `attempts >= maxAttempts`: never claimed, stays queryable. `observeJobBacklog` exports `flash_jobs_backlog{stage,state=ready|leased|dead}` and `flash_jobs_oldest_ready_seconds{stage}`.
- Events to the api: `notifyFlashStored` / `notifyFlashCasted` (`libs/database/src/notify.ts`) call `pg_notify` on channels `flash_stored` / `flash_casted` inside the completing transaction; payload is the subscription JSON (`flash_id`, `timestamp` as strings).

## Engine specifics

- **database-engine**: batches (`BATCH_SIZE`, `BATCH_FLUSH_INTERVAL_MS`); one transaction does the upsert, a cast-job enqueue per flash and `notifyFlashStored`, and messages are acked after commit. Failure requeues after `BATCH_RETRY_DELAY_MS`. Prefetch is forced to ≥ 2×BATCH_SIZE.
- **image-engine**: `CircuitBreaker` (30 consecutive pin failures → open 5 min → half-open single trial). Download/pin retries via `withRetry`. `CONSUMER_RATE_LIMIT` req/min.
- **neynar-engine**: `JobWorker` on stage `cast` (`CAST_JOB_CONCURRENCY` 5, `CAST_JOB_LEASE_MS` 60000, `CAST_JOB_MAX_ATTEMPTS` 5, `CAST_JOB_POLL_INTERVAL_MS` 1000). User lookup by username; the `flashcastr_flashes` row is inserted (`cast_hash NULL`) before `publishCast`, and every cast carries a stable Neynar `idem` key (`buildCastIdemKey(flashId)`), so a redelivery or a race with the retry worker cannot double-cast. Retry worker every `RETRY_INTERVAL_MS` disables `auto_cast` on revoked/403.
- **flash-engine**: croner (`CRON_SCHEDULE`, `protect: true`), peak hours in `Europe/Paris`, in-memory `recentFlashIds` dedupe (restart re-publishes; downstream is idempotent). Reads registered players from Postgres at boot and on a periodic refresh loop (default every 5 min), with a refresh-if-stale check before each poll; exits if the initial Postgres load fails.
- **api**: `withApiKey` (constant-time, `x-api-key`) on `setUserAutoCast`/`deleteUser`; `withRateLimit` per client IP on `initiateSignup` (creates a Neynar-sponsored signer, billed in credits) and `saveFlashIdentification`. `WhereBuilder` + `clampLimit` (max 500) for list queries; `createCache` keyed by args. Subscriptions bridge through `PostgresSubscriptionBridge` (`subscription-bridge.ts`): a dedicated `pg.Client` (not pooled) that `LISTEN`s on both channels, feeds `InMemoryPubSub`, and reconnects with backoff; events during a reconnect are lost, which is correct for live subscriptions. `/health` = Postgres (503 on error) + `isListening()` (`degraded`, never 503). Tracing preloaded via `instrumentation.ts` then `server.ts` is dynamically imported.

## Process lifecycle (libs/runtime)

`runService(name, { registry, metricsPort, healthChecks, start })`: serves `/metrics` + `/health` (503 only on `error`), runs `onShutdown` steps in reverse on SIGINT/SIGTERM, flushes Loki, exits 1 on unhandled rejection/exception. Register shutdown steps outermost-first (pool, publisher, consumer).

## Database

| Table | Notes |
|-------|-------|
| `flashes` | upsert on `flash_id`, `ipfs_cid` only ever overwritten with a non-empty value. Surviving indexes (post `0005_flashes_index_diet.sql`): `flashes_pkey` (flash_id), `idx_flashes_timestamp` (unfiltered list, cities' `timestamp >=` range), `idx_flashes_city` (`getAllCities`' `SELECT DISTINCT city`), `idx_flashes_player_timestamp` (`lower(player)`, for `WhereBuilder.eqIgnoreCase`), `idx_flashes_city_timestamp` (`lower(city)`, ditto) |
| `flashcastr_flashes` | `cast_hash NULL` = claimed, cast pending or failed (retry worker picks it up). Surviving indexes: `flashcastr_flashes_pkey` (id), `unique_flash_id` (flash_id, the join target from `flashes`), `idx_flashcastr_flashes_user_fid` |
| `flashcastr_users` | encrypted `signer_uuid` (AES-256-GCM, `SIGNER_ENCRYPTION_KEY`), `auto_cast`. Deletes are hard (`deleteWithFlashes` transaction) |
| `flash_identifications` | upsert on `source_ipfs_cid` (unique index since `0003`) |
| `flash_jobs` | see Job pipeline |

Merged is not applied: nothing runs migrations on deploy. After merging one, run `railway run -s Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/migrate.ts'` and check `schema_migrations`.

Schema source lives in `migrations/` (see README "Local database"); it documents what's applied in Railway Postgres, not a fresh-install source of truth.

## Deployment

- Railway (Dockerfile per app, auto-deploy on main): flash-engine, database-engine, neynar-engine, api, agent-invaders. Railway service settings own Dockerfile path/watch patterns.
- Those 5 Dockerfiles are multi-stage: builder runs `npm ci` + `esbuild src/main.ts --bundle --platform=node --format=esm --target=node22` with `pg`/`amqplib`/`@neynar/nodejs-sdk` (and `@opentelemetry/*` for api) marked `--external`; a generated minimal `package.json` installs just those externals into the runtime stage, which copies only that `node_modules` + the bundle — no `libs/`, no source, no dev deps. agent-invaders imports no `@flashcastr/*` lib, so its Dockerfile skips the `libs/` COPY entirely.
- image-engine's Dockerfile stays tsx-based (droplet is its real deploy path, see below); only used locally via `docker-compose up`.
- DigitalOcean droplet via `deploy-image-engine.yml` (ssh + pm2): image-engine. The droplet's Node must be ≥22.
- CI: `npm run typecheck` + `npm test` on push/PR (no Docker build in CI).

## Env

See `.env.example`. Hardening knobs: `API_KEY`, `TRUST_PROXY_HOPS`, `RATE_LIMIT_SIGNUP_PER_10MIN`, `RATE_LIMIT_IDENTIFICATION_PER_MIN`, `CORS_ORIGINS`, `GRAPHQL_INTROSPECTION`, `CONSUMER_MAX_ATTEMPTS`, `BATCH_RETRY_DELAY_MS`, `TRENDING_CACHE_TTL_MS`. Production api runs with `GRAPHQL_INTROSPECTION=false` and `CORS_ORIGINS=https://www.flashcastr.app,https://flashcastr.app` (apex 307s to www); a new frontend origin, including Vercel previews, must be added there or its browser calls fail CORS.

## Gotchas

- Frontend calls `initiateSignup`, `pollSignupStatus`, `saveFlashIdentification` from the browser with no key; never put `withApiKey` on them.
- With `LOKI_URL` set, `createLogger` writes to the Loki stream only, not stdout: `railway logs` shows just the few `console.*` lines, and app logs are lost if Loki is down. Read app logs in Grafana/Loki until the logger tees to stdout.
- `getFid()` (api) is memoized per process; the developer mnemonic is only read there.
- Neynar `PostCastReqBodyEmbeds` types every embed field as required; `buildFlashCast` casts a url-only embed.
- Prometheus `operation_name` label is the schema root field, not the client operation name.
- esbuild's CJS interop shim for `dotenv`'s internal `require("fs")` throws `Dynamic require of "fs" is not supported` under plain `--format=esm` output; the Docker builder stages carry a `--banner:js` injecting `createRequire(import.meta.url)` to fix it. Any new bundled app needs the same banner.
- `migrations/0003_flash_identifications_unique.sql` replaces the non-unique `idx_flash_identifications_source` with a unique index (dedupes existing rows first, keeping the newest `created_at`) so `FlashIdentificationsDb.upsert`'s `ON CONFLICT (source_ipfs_cid)` has a matching target — it 500'd on every call before this. `npm run migrate -- --baseline` now requires an explicit upper-bound filename (see README "Local database"); the old no-argument form silently baselined everything pending.
- The migrator runs each file in one transaction, and Postgres holds every lock acquired in it until COMMIT regardless of statement order. `DROP INDEX` takes ACCESS EXCLUSIVE (blocks reads+writes); plain `CREATE INDEX` only takes SHARE (blocks writes only). A migration combining both (see `0005_flashes_index_diet.sql`) must build/`ANALYZE` first and drop last, or the DROP's ACCESS EXCLUSIVE lock sits for the whole build instead of milliseconds. Reusing a to-be-dropped index's name needs a throwaway name + `ALTER INDEX ... RENAME` at the end (fast, catalog-only) since you can't `CREATE` under a name that still exists.
