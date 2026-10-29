# flashcastr.services

npm-workspaces monorepo: 3 pipeline engines, 1 GraphQL API, 1 LangGraph agent, 11 shared libs.

**Epic `postgres-job-pipeline` is complete.** RabbitMQ has been fully removed. Engines now coordinate through a Postgres `flash_jobs` table (`pin` and `cast` stages, claimed by `JobWorker`s) and `pg_notify`/`LISTEN` for the api's GraphQL subscriptions. Sections below describe what runs today.

## Workspace

- `apps/` — flash-engine, image-engine, neynar-engine, api, agent-invaders (own `CLAUDE.md`, no lib imports)
- `libs/` — shared-types, jobs, database, proxy, metrics, health, logger, crypto, config, resilience, runtime
- Imports use `@flashcastr/<lib>`; resolved from source via the `@flashcastr/source` exports condition. Dev runs under `tsx` directly, no build step; Docker images for the 5 Railway apps bundle with esbuild (see Deployment).
- `scripts/` — `migrate.ts` (applies pending SQL migrations, see Database)

## Stack

Node 22.23.4 (Dockerfiles pin `node:22.23.4-slim`, engines `>=22.23.4`, `.nvmrc`; the floor is CVE-2026-111497, the Brotli decoder out-of-bounds write), TypeScript strict `nodenext`, Postgres (`pg`), Pinata (legacy default) + Backblaze B2 (`@aws-sdk/client-s3`, `IMAGE_STORE=b2`), Neynar SDK, Apollo Server 5 + `@as-integrations/express4` + graphql-ws 6, prom-client, pino + `pino-loki` via `@flashcastr/logger`.

## Commands

```bash
npm install
npm run typecheck          # tsc over apps/, libs/, scripts/ (what CI runs)
npm test                   # vitest: libs/*/src/**/*.test.ts, apps/*/src/**/*.test.ts, apps/*/tests/**
npx tsx --watch apps/<service>/src/main.ts
docker-compose up
```

Lockfile: regenerate with `npm install --legacy-peer-deps` on Node 22's own npm 10 after dependency changes; the node image's npm ci rejects npm 11 lockfiles, and the flag is required (see Gotchas). `npm ci` itself needs no flag.

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

- **image-engine**: `JobWorker` claiming `flash_jobs` `stage='pin'` (`CONSUMER_CONCURRENCY`, `PIN_JOB_LEASE_MS`, `CONSUMER_MAX_ATTEMPTS` default 10). `CircuitBreaker` (30 consecutive pin failures → open 5 min → half-open single trial) pauses/resumes the `JobWorker` directly. Download/pin retries via `withRetry`; `CONSUMER_RATE_LIMIT` req/min. Completion runs through one Postgres transaction (`updateIpfsCid` + `complete(pin)` + `enqueue(cast)` + `notifyFlashStored`) behind a `PinCompletionPort`; `IMAGE_STORE` (`pinata` default in production | `b2`) selects `PinataPinner` vs `B2Pinner`, the latter writing `feed/<sha256>` to B2 and setting `image_tier='feed'` (Pinata leaves it `NULL`) — flips to `b2` once verified stable, see Local notes.
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
| `flashes.image_tier` | nullable text, `feed`\|`keep`\|`NULL`. `NULL` = legacy Pinata row, never backfilled — `image_url` resolution falls back to the origin `img` URL; `feed` (image-engine's `B2Pinner`) or `keep` (the promote sweep) route through the api's B2 redirect instead. No index: metadata-only on an 8.1M-row table (0007's own migration comment) |

Merging a migration deploys it: the api's Dockerfile bundles `scripts/migrate.ts` to `dist/migrate.js` next to `main.js` and copies `migrations/` into the runtime image, and its Railway service's `preDeployCommand: ["node dist/migrate.js"]` runs it before starting the new container, failing the deploy if it exits non-zero. `runMigrations` takes a `pg_advisory_lock` for the run, so a manual run overlapping the deploy's is safe. Railway does not roll a deployment's containers live until the new one reaches `Active`, and a failed pre-deploy command means "the deployment will not proceed" — so the previous api container keeps serving on a failed migration. Migrations must stay expand/contract (backward compatible with the previous code): the other four pipeline services still deploy in parallel and don't wait on the api's migration to finish. Manual fallback still works: `railway run -s Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npx tsx scripts/migrate.ts'`; check `schema_migrations` after.

That Railway follow-up is applied and verified (2026-09-20): `flashcastr.api.9094` carries `preDeployCommand: ["node dist/migrate.js"]`, `preDeployTimeoutSeconds: 600` (0005 took 27s, 0006 14s; 600 covers a much larger index build), and watch patterns `/apps/api/**`, `/libs/**`, `/migrations/**`, `/scripts/migrate.ts`, `package.json`, `tsconfig.base.json` — without the last two a PR that only adds a migration file would not trigger an api deploy at all. A deploy's pre-deploy output appears in `railway logs -d -s flashcastr.api.9094 <deploymentId>` as one `skipped`/`applied` line per migration; a fresh deploy logged `skipped 0001…0007`. Note it is not visible in the default `railway logs` stream, and `railway redeploy` reuses the previous deployment's settings snapshot — after changing these settings, force a real deploy with GraphQL `serviceInstanceDeploy(environmentId, serviceId, latestCommit: true)`.

Second one-time Railway follow-up, independent of the migration one above: `scripts/Dockerfile` bundles `promote-keep-set.ts` as a standalone one-shot container but isn't registered as a Railway service yet — create one with `dockerfilePath: scripts/Dockerfile`, `watchPatterns` extended with `scripts/**`, `libs/**`, `package.json`, `package-lock.json`, `tsconfig.base.json`, `cronSchedule: "0 6 * * 1"` (weekly), and env `DATABASE_URL`, `B2_S3_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_PROMOTE_KEY_ID`, `B2_PROMOTE_KEY`, optionally `PINATA_GATEWAY`/`PROMOTE_CONCURRENCY`/`PROMOTE_RATE_LIMIT` — until then the keep-set sweep only runs manually.

Schema source lives in `migrations/` (see README "Local database") — `0001_baseline.sql` is a straight `pg_dump --schema-only` of production, and every migration since has run there for real, so applying `migrations/` in order against an empty database now reconstructs the production schema exactly.

## Deployment

- Railway (Dockerfile per app, auto-deploy on main): flash-engine, image-engine, neynar-engine, api, agent-invaders — all 5 apps. Railway service settings own Dockerfile path/watch patterns.
- Those 5 Dockerfiles are multi-stage: builder runs `npm ci` + `esbuild src/main.ts --bundle --platform=node --format=esm --target=node22` with `pg` (and `@neynar/nodejs-sdk` for api/agent-invaders/neynar-engine) marked `--external`; a generated minimal `package.json` installs just those externals into the runtime stage, which copies only that `node_modules` + the bundle — no `libs/`, no source, no dev deps. agent-invaders imports no `@flashcastr/*` lib, so its Dockerfile skips the `libs/` COPY entirely. The api's Dockerfile additionally bundles `scripts/migrate.ts` to `dist/migrate.js` with the same flags plus a banner shim providing `__dirname` (the ESM bundle has none natively — `resolveMigrationsDir(__dirname)` needs it) and copies `migrations/` into the runtime stage; see the migration pre-deploy note above.
- CI: `npm run typecheck` + `npm test` on push/PR (no Docker build in CI).

## Env

See `.env.example`. Hardening knobs: `API_KEY`, `TRUST_PROXY_HOPS`, `RATE_LIMIT_SIGNUP_PER_10MIN`, `RATE_LIMIT_IDENTIFICATION_PER_MIN`, `CORS_ORIGINS`, `GRAPHQL_INTROSPECTION`, `CONSUMER_MAX_ATTEMPTS`, `TRENDING_CACHE_TTL_MS`. Production api runs with `GRAPHQL_INTROSPECTION=false` and `CORS_ORIGINS=https://www.flashcastr.app,https://flashcastr.app` (apex 307s to www); a new frontend origin, including Vercel previews, must be added there or its browser calls fail CORS. `NODE_ENV` must be `production` on `flashcastr.api.9094` — today the only one of the 5 Railway services missing it (the api's Dockerfile now sets it for local `docker run` parity, but Railway's own service variable is what matters in production). The real guard against leaking GraphQL stack traces / raw resolver error messages is `errorFormattingOptions` (`apps/api/src/errorFormatting.ts`, spread into the `ApolloServer` constructor) — `includeStacktraceInErrorResponses: false` plus a `formatError` that genericizes any error still carrying the default `INTERNAL_SERVER_ERROR` code. That guard holds regardless of `NODE_ENV`; don't treat the env var alone as the fix.

## Secret rotation

Rotated 2026-10-26 (Railway breach response): Postgres role password (by hand, before this pass), `SIGNER_ENCRYPTION_KEY`, all three B2 scoped keys, `API_KEY`, `ADMIN_TOKEN`, Grafana admin. Recovery copy of the new values: `~/.claude/rotations/flashcastr-20261026.env` (mode 600). What that pass established:

- A variable change alone does not re-credential a running service. Railway records it as a `SKIPPED` deployment (watch patterns) and the container keeps the env it booted with, so services stay up on the *old* secret and die later — whenever a pooled connection drops — with no deploy event linking cause to effect. After rotating anything, force a real deploy per service: GraphQL `serviceInstanceDeploy(environmentId, serviceId, latestCommit: true)`. `railway redeploy` reuses the old settings snapshot and is not enough.
- Project-level **shared** variables are injected into services and are indistinguishable from service-level ones in `railway variable list`. `NEYNAR_API_KEY` was shared-only for `neynar.9092` + `flashcastr.api.9094`; deleting the shared copy crashed both on `requireEnv` at boot. Before deleting a shared variable, confirm every service that reads it has its own copy. Both now hold service-level values; no shared variables remain in the project.
- `SIGNER_ENCRYPTION_KEY` has no key-version envelope (`libs/crypto` is bare `iv:authTag:ciphertext`), so rotating it means re-encrypting `flashcastr_users.signer_uuid` in the same pass: decrypt with old, encrypt with new, verify every row decrypts under the new key, all in one transaction, with the api and neynar-engine down so nothing writes mid-migration. Postgres has no public TCP proxy, and pgcrypto has no GCM — run such a script inside a service container (`railway ssh -s flashes.9090`, which carries `pg` and a valid `DATABASE_URL`) and place it under `/app` so `require("pg")` resolves.
- `GF_SECURITY_ADMIN_PASSWORD` only applies when Grafana first provisions its database; on an existing volume the variable is inert and the old password keeps working. Reset for real inside the container: `./bin/grafana cli --homepath /usr/share/grafana admin reset-admin-password '<new>'`.
- B2 keys are replace-then-revoke, never the reverse: `b2_create_key` mirroring the old key's `bucketIds`/`namePrefix`/`capabilities` (`b2_list_keys` shows all three), write the new pair, redeploy, verify, then `b2_delete_key` the old id. `promote-sweep` is a cron service — it picks up current variables on its next scheduled run, so it needs no deploy, and forcing one would fire a full sweep.

## Gotchas

- A full dependency re-resolve (`npm install`, `npm audit fix`) crashes on npm 10.9.9 with `Cannot read properties of null (reading 'edgesOut')` in arborist's `#loadPeerSet`, triggered by vitest's optional peer chain `happy-dom` -> `jsdom` -> `canvas`. It reproduces on an untouched `package.json` with no lockfile, so it is not caused by any local change. `--legacy-peer-deps` resolves cleanly, and `npm ci` from the committed lockfile is unaffected — which is why CI and the Docker builds never see it. `npm audit fix` cannot be used at all here; apply fixes as explicit version bumps plus `overrides`.
- `@faker-js/faker@7.6.0` is a **production** dependency of `@farcaster/core` and really does ship inside the api and agent-invaders bundles (~325 references; it is also most of the ~9MB bundle size). It cannot be overridden: every patched faker (the advisory covers `<=10.4.0`) has dropped `faker.datatype.number`, which `core`'s factories call *at module import time*, so the override crashes both services on boot. `core` exports only `.`, so the factory module cannot be bypassed. This leaves 3 permanent `npm audit` highs from one root cause; the advisory is `helpers.fake` code execution, and nothing here ever calls faker. Re-check when `@farcaster/core` moves faker to devDependencies.
- `CastAddBody` gained a required `formatVersion` in `@farcaster/core` 0.21 ("0 = plain text", which is what `core` itself defaults to). `hubFarcasterGateway.castBody` sets it explicitly.
- Frontend calls `initiateSignup`, `pollSignupStatus`, `saveFlashIdentification` from the browser with no key; never put `withApiKey` on them.
- `@flashcastr/logger` always writes to stdout (raw pino JSON lines, no pino-pretty) and additionally tees to Loki via `pino.multistream` when `LOKI_URL` is set — `railway logs` shows app output again regardless of Loki's availability. Railway rate-limits ingested logs at 500 lines/sec per replica (per-replica ceiling, not per-service); this pipeline runs well under it. `pino-loki`'s batch timer is a non-unref'd `setInterval`, so merely importing a lib that builds a logger (e.g. `@flashcastr/database`) keeps the event loop alive — a short-lived script must `await closeLoggers()` (`@flashcastr/logger`) alongside `closePool()` or it hangs after its last line. This is what timed out the api's migration pre-deploy step for 600s on PR #34.
- `getFid()` (api) is memoized per process; the developer mnemonic is only read there.
- Neynar `PostCastReqBodyEmbeds` types every embed field as required; `buildFlashCast` casts a url-only embed.
- Prometheus `operation_name` label is the schema root field, not the client operation name.
- esbuild's CJS interop shim for `dotenv`'s internal `require("fs")` throws `Dynamic require of "fs" is not supported` under plain `--format=esm` output; the Docker builder stages carry a `--banner:js` injecting `createRequire(import.meta.url)` to fix it. Any new bundled app needs the same banner.
- `migrations/0003_flash_identifications_unique.sql` replaces the non-unique `idx_flash_identifications_source` with a unique index (dedupes existing rows first, keeping the newest `created_at`) so `FlashIdentificationsDb.upsert`'s `ON CONFLICT (source_ipfs_cid)` has a matching target — it 500'd on every call before this. `npm run migrate -- --baseline` now requires an explicit upper-bound filename (see README "Local database"); the old no-argument form silently baselined everything pending.
- The migrator runs each file in one transaction, and Postgres holds every lock acquired in it until COMMIT regardless of statement order. `DROP INDEX` takes ACCESS EXCLUSIVE (blocks reads+writes); plain `CREATE INDEX` only takes SHARE (blocks writes only). A migration combining both (see `0005_flashes_index_diet.sql`) must build/`ANALYZE` first and drop last, or the DROP's ACCESS EXCLUSIVE lock sits for the whole build instead of milliseconds. Reusing a to-be-dropped index's name needs a throwaway name + `ALTER INDEX ... RENAME` at the end (fast, catalog-only) since you can't `CREATE` under a name that still exists.
