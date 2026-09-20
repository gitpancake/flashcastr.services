# flashcastr.services

npm-workspaces monorepo: 3 pipeline engines, 1 GraphQL API, 1 LangGraph agent, 11 shared libs.

**Epic `postgres-job-pipeline` is complete.** RabbitMQ has been fully removed. Engines now coordinate through a Postgres `flash_jobs` table (`pin` and `cast` stages, claimed by `JobWorker`s) and `pg_notify`/`LISTEN` for the api's GraphQL subscriptions. Sections below describe what runs today.

## Workspace

- `apps/` — flash-engine, image-engine, neynar-engine, api, agent-invaders (own `CLAUDE.md`, no lib imports)
- `libs/` — shared-types, jobs, database, proxy, metrics, health, logger, crypto, config, resilience, runtime
- Imports use `@flashcastr/<lib>`; resolved from source via the `@flashcastr/source` exports condition. Dev runs under `tsx` directly, no build step; Docker images for the 5 Railway apps bundle with esbuild (see Deployment).
- `scripts/` — `migrate.ts` (applies pending SQL migrations, see Database)

## Stack

Node 22 (`node:22-slim`, engines `>=22`), TypeScript strict `nodenext`, Postgres (`pg`), Pinata, Neynar SDK, Apollo Server 5 + `@as-integrations/express4` + graphql-ws 6, prom-client, pino + `pino-loki` via `@flashcastr/logger`.

## Commands

```bash
npm install
npm run typecheck          # tsc over apps/, libs/, scripts/ (what CI runs)
npm test                   # vitest: libs/*/src/**/*.test.ts, apps/*/src/**/*.test.ts, apps/*/tests/**
npx tsx --watch apps/<service>/src/main.ts
docker-compose up
```

Lockfile: regenerate with `npx npm@10 install --package-lock-only` after dependency changes; the node image's npm ci rejects npm 11 lockfiles.

## Message Flow

```
flash-engine ==enqueue pin job (flash_jobs)==> image-engine ==enqueue cast job (flash_jobs)==> neynar-engine
                        image-engine --NOTIFY flash_stored--> api      neynar-engine --NOTIFY flash_casted--> api (graphql subscriptions)
```

`==>` is a `flash_jobs` row transition; `-->` is a `pg_notify`. flash-engine writes each flash to `flashes` and enqueues a `pin` job in the same transaction. image-engine's `JobWorker` claims `pin` jobs, pins to IPFS, and in one transaction updates `ipfs_cid`, completes the `pin` job, enqueues the `cast` job, and calls `notifyFlashStored`. neynar-engine's `JobWorker` claims `cast` jobs, casts via Neynar (or deletes the job for non-users), completes the job, and calls `notifyFlashCasted`. The api has no direct connection to either engine — it only `LISTEN`s on the two Postgres channels.

## Job pipeline (libs/jobs + `FlashJobsDb`)

- `flash_jobs (flash_id, stage 'pin'|'cast', attempts, next_attempt_at, last_error, created_at)`, PK `(flash_id, stage)`. A row exists only while work is outstanding; success deletes it.
- `FlashJobsDb.enqueue/complete` take a client so callers put them in their own transaction. `claim` is one statement (`FOR UPDATE SKIP LOCKED` inside it) that bumps `attempts` and sets `next_attempt_at = now() + lease`; no transaction is held during the work, and a crashed worker's job is reclaimed when the lease expires.
- `JobWorker`: N claim loops; `TransientError` → `defer` (attempt handed back), `FatalMessageError` / `shouldRetry === false` → dead, otherwise backoff 1s→30s. `pause()/resume()`, `isRunning()` for `/health`, `close()` waits for in-flight handlers. `TransientError`/`FatalMessageError` live in `libs/jobs`.
- Dead job = `attempts >= maxAttempts`: never claimed, stays queryable. `observeJobBacklog` exports `flash_jobs_backlog{stage,state=ready|leased|dead}` and `flash_jobs_oldest_ready_seconds{stage}`.
- Events to the api: `notifyFlashStored` / `notifyFlashCasted` (`libs/database/src/notify.ts`) call `pg_notify` on channels `flash_stored` / `flash_casted` inside the completing transaction; payload is the subscription JSON (`flash_id`, `timestamp` as strings).

## Engine specifics

- **image-engine**: `JobWorker` claiming `flash_jobs` `stage='pin'` (`CONSUMER_CONCURRENCY`, `PIN_JOB_LEASE_MS`, `CONSUMER_MAX_ATTEMPTS` default 10). `CircuitBreaker` (30 consecutive pin failures → open 5 min → half-open single trial) pauses/resumes the `JobWorker` directly. Download/pin retries via `withRetry`; `CONSUMER_RATE_LIMIT` req/min. Completion runs through one Postgres transaction (`updateIpfsCid` + `complete(pin)` + `enqueue(cast)` + `notifyFlashStored`) behind a `PinCompletionPort`.
- **neynar-engine**: `JobWorker` on stage `cast` (`CAST_JOB_CONCURRENCY` 5, `CAST_JOB_LEASE_MS` 60000, `CAST_JOB_MAX_ATTEMPTS` 5, `CAST_JOB_POLL_INTERVAL_MS` 1000). User lookup by username; the `flashcastr_flashes` row is inserted (`cast_hash NULL`) before `publishCast`, and every cast carries a stable Neynar `idem` key (`buildCastIdemKey(flashId)`), so a redelivery or a race with the retry worker cannot double-cast. Retry worker every `RETRY_INTERVAL_MS` disables `auto_cast` on revoked/403.
- **flash-engine**: croner (`CRON_SCHEDULE`, `protect: true`); peak (`Europe/Paris` 06:00-23:00) polls every tick, off-peak is gated by `poll-gate.ts`'s `shouldPoll` to a minimum interval (`OFF_PEAK_MIN_INTERVAL_MS`, default 10 min) instead of a coin flip, logging a skip at info with the reason and seconds to the next eligible poll. In-memory `recentFlashIds` dedupe (restart re-writes; `insertNew`/job enqueue are idempotent per `flash_id`). `flash_engine_last_successful_fetch_timestamp_seconds` gauge + `sourcePoll` health check go `degraded` (never `error`) past 30 min without a successful fetch. Reads registered players from Postgres at boot and on a periodic refresh loop (default every 5 min), with a refresh-if-stale check before each poll; exits if the initial Postgres load fails.
- **api**: `withApiKey` (constant-time, `x-api-key`) on `setUserAutoCast`/`deleteUser`; `withRateLimit` per client IP on `initiateSignup` (creates a Neynar-sponsored signer, billed in credits) and `saveFlashIdentification`. `WhereBuilder` + `clampLimit` (max 500) for list queries; `createCache` keyed by args. Subscriptions bridge through `PostgresSubscriptionBridge` (`subscription-bridge.ts`): a dedicated `pg.Client` (not pooled) that `LISTEN`s on both channels, feeds `InMemoryPubSub`, and reconnects with backoff; events during a reconnect are lost, which is correct for live subscriptions. `/health` = Postgres (503 on error) + `isListening()` (`degraded`, never 503).

## Process lifecycle (libs/runtime)

`runService(name, { registry, metricsPort, healthChecks, start })`: serves `/metrics` + `/health` (503 only on `error`), runs `onShutdown` steps in reverse on SIGINT/SIGTERM, flushes Loki, exits 1 on unhandled rejection/exception. Register shutdown steps outermost-first (job worker/cron before the Postgres pool it depends on).

## Database

| Table | Notes |
|-------|-------|
| `flashes` | upsert on `flash_id`, `ipfs_cid` only ever overwritten with a non-empty value. Surviving indexes (post `0005_flashes_index_diet.sql`): `flashes_pkey` (flash_id), `idx_flashes_timestamp` (unfiltered list, cities' `timestamp >=` range), `idx_flashes_city` (`getAllCities`' `SELECT DISTINCT city`), `idx_flashes_player_timestamp` (`lower(player)`, for `WhereBuilder.eqIgnoreCase`), `idx_flashes_city_timestamp` (`lower(city)`, ditto) |
| `flashcastr_flashes` | `cast_hash NULL` = claimed, cast pending or failed (retry worker picks it up). Surviving indexes: `flashcastr_flashes_pkey` (id), `unique_flash_id` (flash_id, the join target from `flashes`), `idx_flashcastr_flashes_user_fid` |
| `flashcastr_users` | encrypted `signer_uuid` (AES-256-GCM, `SIGNER_ENCRYPTION_KEY`), `auto_cast`. Deletes are hard (`deleteWithFlashes` transaction) |
| `flash_identifications` | upsert on `source_ipfs_cid` (unique index since `0003`) |
| `flash_jobs` | see Job pipeline |
| `farcaster_casts` | legacy, PK `thread_hash`; present in production (captured in `0001_baseline.sql`) but nothing in this codebase reads or writes it — leave alone |

Merging a migration deploys it: the api's Dockerfile bundles `scripts/migrate.ts` to `dist/migrate.js` next to `main.js` and copies `migrations/` into the runtime image, and its Railway service's `preDeployCommand: ["node dist/migrate.js"]` runs it before starting the new container, failing the deploy if it exits non-zero. `runMigrations` takes a `pg_advisory_lock` for the run, so a manual run overlapping the deploy's is safe. Railway does not roll a deployment's containers live until the new one reaches `Active`, and a failed pre-deploy command means "the deployment will not proceed" — so the previous api container keeps serving on a failed migration. Migrations must stay expand/contract (backward compatible with the previous code): the other four pipeline services still deploy in parallel and don't wait on the api's migration to finish. Manual fallback still works: `railway run -s Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/migrate.ts'`; check `schema_migrations` after.

One-time Railway follow-up once this merges: on the `flashcastr.api.9094` service, set `preDeployCommand: ["node dist/migrate.js"]`, `preDeployTimeoutSeconds: 600` (0005 took 27s, 0006 14s; 600 covers a much larger index build), and extend watch patterns with `/migrations/**` and `/scripts/migrate.ts` — today a PR that only adds a migration file doesn't trigger an api deploy at all.

Schema source lives in `migrations/` (see README "Local database") — `0001_baseline.sql` is a straight `pg_dump --schema-only` of production, and every migration since has run there for real, so applying `migrations/` in order against an empty database now reconstructs the production schema exactly.

## Deployment

- Railway (Dockerfile per app, auto-deploy on main): flash-engine, image-engine, neynar-engine, api, agent-invaders — all 5 apps. Railway service settings own Dockerfile path/watch patterns.
- Those 5 Dockerfiles are multi-stage: builder runs `npm ci` + `esbuild src/main.ts --bundle --platform=node --format=esm --target=node22` with `pg` (and `@neynar/nodejs-sdk` for api/agent-invaders/neynar-engine) marked `--external`; a generated minimal `package.json` installs just those externals into the runtime stage, which copies only that `node_modules` + the bundle — no `libs/`, no source, no dev deps. agent-invaders imports no `@flashcastr/*` lib, so its Dockerfile skips the `libs/` COPY entirely. The api's Dockerfile additionally bundles `scripts/migrate.ts` to `dist/migrate.js` with the same flags plus a banner shim providing `__dirname` (the ESM bundle has none natively — `resolveMigrationsDir(__dirname)` needs it) and copies `migrations/` into the runtime stage; see the migration pre-deploy note above.
- CI: `npm run typecheck` + `npm test` on push/PR (no Docker build in CI).

## Env

See `.env.example`. Hardening knobs: `API_KEY`, `TRUST_PROXY_HOPS`, `RATE_LIMIT_SIGNUP_PER_10MIN`, `RATE_LIMIT_IDENTIFICATION_PER_MIN`, `CORS_ORIGINS`, `GRAPHQL_INTROSPECTION`, `CONSUMER_MAX_ATTEMPTS`, `TRENDING_CACHE_TTL_MS`. Production api runs with `GRAPHQL_INTROSPECTION=false` and `CORS_ORIGINS=https://www.flashcastr.app,https://flashcastr.app` (apex 307s to www); a new frontend origin, including Vercel previews, must be added there or its browser calls fail CORS.

## Gotchas

- Frontend calls `initiateSignup`, `pollSignupStatus`, `saveFlashIdentification` from the browser with no key; never put `withApiKey` on them.
- `@flashcastr/logger` always writes to stdout (raw pino JSON lines, no pino-pretty) and additionally tees to Loki via `pino.multistream` when `LOKI_URL` is set — `railway logs` shows app output again regardless of Loki's availability. Railway rate-limits ingested logs at 500 lines/sec per replica (per-replica ceiling, not per-service); this pipeline runs well under it. `pino-loki`'s batch timer is a non-unref'd `setInterval`, so merely importing a lib that builds a logger (e.g. `@flashcastr/database`) keeps the event loop alive — a short-lived script must `await closeLoggers()` (`@flashcastr/logger`) alongside `closePool()` or it hangs after its last line. This is what timed out the api's migration pre-deploy step for 600s on PR #34.
- `getFid()` (api) is memoized per process; the developer mnemonic is only read there.
- Neynar `PostCastReqBodyEmbeds` types every embed field as required; `buildFlashCast` casts a url-only embed.
- Prometheus `operation_name` label is the schema root field, not the client operation name.
- esbuild's CJS interop shim for `dotenv`'s internal `require("fs")` throws `Dynamic require of "fs" is not supported` under plain `--format=esm` output; the Docker builder stages carry a `--banner:js` injecting `createRequire(import.meta.url)` to fix it. Any new bundled app needs the same banner.
- `migrations/0003_flash_identifications_unique.sql` replaces the non-unique `idx_flash_identifications_source` with a unique index (dedupes existing rows first, keeping the newest `created_at`) so `FlashIdentificationsDb.upsert`'s `ON CONFLICT (source_ipfs_cid)` has a matching target — it 500'd on every call before this. `npm run migrate -- --baseline` now requires an explicit upper-bound filename (see README "Local database"); the old no-argument form silently baselined everything pending.
- The migrator runs each file in one transaction, and Postgres holds every lock acquired in it until COMMIT regardless of statement order. `DROP INDEX` takes ACCESS EXCLUSIVE (blocks reads+writes); plain `CREATE INDEX` only takes SHARE (blocks writes only). A migration combining both (see `0005_flashes_index_diet.sql`) must build/`ANALYZE` first and drop last, or the DROP's ACCESS EXCLUSIVE lock sits for the whole build instead of milliseconds. Reusing a to-be-dropped index's name needs a throwaway name + `ALTER INDEX ... RENAME` at the end (fast, catalog-only) since you can't `CREATE` under a name that still exists.
