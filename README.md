# flashcastr.services

npm-workspaces monorepo for the Flashcastr pipeline: three engines, a GraphQL API, and the `agent-invaders` LangGraph agent, all coordinated through a Postgres `flash_jobs` table and `LISTEN`/`NOTIFY` — no message broker. Node 22, TypeScript, run from source with `tsx`.

## Architecture

```
Space Invaders API
       |
  flash-engine    -- writes flashes, enqueues flash_jobs('pin') -->  Postgres
                                                                          |
  image-engine    <-- JobWorker claims stage='pin' -----------------------
       |
       +-- pins image to IPFS
       +-- one transaction: sets ipfs_cid, completes the 'pin' job,
       |     enqueues flash_jobs('cast'), pg_notify('flash_stored', ...)
       v
  Postgres
       |
  neynar-engine   <-- JobWorker claims stage='cast' ----------------------
       |
       +-- casts via Neynar
       +-- completes the 'cast' job, pg_notify('flash_casted', ...)
       v
  api              <-- LISTENs on flash_stored + flash_casted, bridges to
                        GraphQL subscriptions (graphql-ws)
```

### Services

| Service | Role | Deploy |
|---------|------|--------|
| **flash-engine** | Cron-fetches flashes from Space Invaders API, writes to Postgres, enqueues `pin` jobs | Railway |
| **image-engine** | `JobWorker` claims `pin` jobs, downloads images and pins them via the store selected by `IMAGE_STORE` (defaults to legacy Pinata/IPFS; `b2` dark-launches a B2 pinner writing the `feed/` tier and stamping `image_tier`), enqueues `cast` jobs | Railway |
| **neynar-engine** | `JobWorker` claims `cast` jobs, casts to Farcaster via Neynar SDK, promotes a flash's image from the B2 `feed/` tier to the permanent `keep/` tier before publishing, retry worker for failed casts | Railway |
| **api** | GraphQL API (Apollo Server 5) with `LISTEN`/`NOTIFY`-backed WebSocket subscriptions; `/i/:flash_id` mints a scoped, prefix-limited B2 download-authorization token server-side and 302s to the tokened object URL (the bucket is `allPrivate`, not public) | Railway |
| **agent-invaders** | LangGraph agent (mentions, daily digest) — no `@flashcastr/*` lib imports | Railway |

**Scripts** (not deployed as services):

| Script | Role | Run |
|--------|------|-----|
| `scripts/promote-keep-set.ts` (`npm run promote-keep-set`) | One-shot sweep: copies pending keep-set rows from `feed/`(B2)/Pinata into the permanent `keep/` B2 tier, verifying SHA-256 per object before flipping `image_tier` to `keep`; idempotent, `--dry-run` prints the pending count without writing. A `scripts/Dockerfile` now bundles it standalone (esbuild `--format=cjs`, `pg` external, `CMD ["node","dist/promote-keep-set.js"]`, no exposed port) for a scheduled container, but it is not yet wired up as a live Railway cron service — that wiring is a documented follow-up | Manual / planned Railway cron |

## Project Structure

```
flashcastr.services/
├── apps/
│   ├── flash-engine/          # Fetch from Space Invaders API, enqueue pin jobs
│   ├── image-engine/          # Claim pin jobs, download + pin to IPFS
│   ├── neynar-engine/         # Claim cast jobs, cast to Farcaster
│   ├── api/                   # GraphQL API + subscriptions
│   └── agent-invaders/        # LangGraph agent (own CLAUDE.md)
│
├── libs/
│   ├── shared-types/          # Flash, job payload types
│   ├── jobs/                  # JobWorker, TransientError/FatalMessageError, queue-depth metrics
│   ├── database/              # PG pool, FlashesDb/FlashJobsDb/etc., notify.ts (pg_notify)
│   ├── proxy/                  # Proxy rotation for API requests
│   ├── metrics/                # Prometheus registry + HTTP server
│   ├── config/                 # Env var helpers
│   ├── health/                 # Health check server
│   ├── logger/                 # Structured logging with Loki shipping
│   ├── crypto/                 # AES-256-GCM decrypt (signer keys)
│   ├── resilience/             # CircuitBreaker
│   └── runtime/                # runService process lifecycle
│
├── migrations/                 # Plain SQL, applied by scripts/migrate.ts
├── docker-compose.yml          # Local dev (Postgres + all services)
├── .env.example                 # Environment variable reference
└── .github/workflows/
    └── ci.yml                   # typecheck + test on push/PR
```

## Getting Started

### Prerequisites

- Node.js 22+
- Docker (for local dev)

### Local Development

```bash
# Install dependencies
npm install

# Start Postgres + all services locally
docker-compose up

# Or run a single service in dev mode
npx tsx --watch apps/flash-engine/src/main.ts
```

### Local database

Schema lives in `migrations/` (plain SQL, no ORM) and is applied by `npm run migrate`, a small runner (`scripts/migrate.ts`) that tracks what's been applied in a `schema_migrations` table.

```bash
# Start Postgres only
docker-compose up -d postgres

# Point at it (docker-compose's postgres service, matching its POSTGRES_* env)
export DATABASE_URL=postgresql://flashcastr:flashcastr@localhost:5432/flashcastr

# Apply all pending migrations
npm run migrate
```

This gets you tables the engines and `api` can boot against and store a flash end to end locally. `0001_baseline.sql` is a straight `pg_dump --schema-only` of production, and every migration since has run there for real, so `npm run migrate` against a fresh database reconstructs the production schema exactly.

`npm run migrate` refuses to run without `DATABASE_URL` set, and re-running it is a no-op (already-applied migrations are skipped). `npm run migrate -- --baseline <name>` requires an explicit upper-bound migration filename (e.g. `--baseline 0001_baseline.sql`) and records only migrations up to and including it as applied *without* running their SQL — used in production to adopt a migration that just documents a schema that already exists there, without baselining later migrations that must actually run. Migrations past the bound are left pending for a subsequent plain `npm run migrate`. See `migrations/0002_drop_deleted.sql` for the deploy order that migration requires (baseline → deploy code → run the real migration).

### Environment Variables

Copy `.env.example` to `.env.local` and fill in values:

```bash
cp .env.example .env.local
```

Key variables per service:

| Variable | Services | Description |
|----------|----------|-------------|
| `DATABASE_URL` | All (job-pipeline services) | Postgres connection string |
| `PROXY_LIST` | flash-engine, image-engine | Comma-separated proxy URLs |
| `CRON_SCHEDULE`, `OFF_PEAK_MIN_INTERVAL_MS` | flash-engine | Poll cadence |
| `IMAGE_STORE` | image-engine | `pinata` (default) or `b2` — which pinner writes new flashes. Defaults to `pinata`, so behavior is unchanged with no env changes; `b2` is dark/unused in production until a documented cockpit flip sets it on the service |
| `PINATA_JWT` | image-engine | Pinata API JWT for IPFS pinning; still required today since `IMAGE_STORE` defaults to `pinata` |
| `B2_S3_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_PUBLIC_BASE` | image-engine | Backblaze B2 S3-compatible endpoint/region/bucket and the `feed/`-scoped pinning key pair, plus the base URL image-engine builds the `feed/` gateway URL from; only read when `IMAGE_STORE=b2` |
| `CONSUMER_CONCURRENCY`, `CONSUMER_RATE_LIMIT`, `CONSUMER_MAX_ATTEMPTS` | image-engine | `pin`-job worker concurrency/rate limit/max attempts |
| `API_PUBLIC_BASE` | image-engine, api | Public base URL the api is reachable at; image-engine only requires it once a B2 tier is live (used to build the `/i/:flash_id` image URL it stores), api always reads it (defaults `http://localhost:4000`) to build that same URL |
| `NEYNAR_API_KEY` | neynar-engine, agent-invaders | Neynar API key for Farcaster |
| `SIGNER_ENCRYPTION_KEY` | neynar-engine | Hex key for decrypting signer UUIDs |
| `RETRY_INTERVAL_MS` | neynar-engine | Failed-cast retry worker interval |
| `CAST_JOB_CONCURRENCY`, `CAST_JOB_LEASE_MS`, `CAST_JOB_MAX_ATTEMPTS`, `CAST_JOB_POLL_INTERVAL_MS` | neynar-engine | `cast`-job worker tuning |
| `B2_S3_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_PROMOTE_KEY_ID`, `B2_PROMOTE_KEY` | neynar-engine | Reused (endpoint/region/bucket) plus a separate promote-scoped key pair for the feed-to-keep promotion `neynar-engine` does before publishing a cast; unset (optional) until a flash actually reaches `image_tier='feed'` |
| `B2_S3_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, `B2_PROMOTE_KEY_ID`, `B2_PROMOTE_KEY` | `promote-keep-set` script | Same B2 bucket, and the promote key pair — never the image-engine key, which is confined to `feed/` and cannot write `keep/` |
| `PINATA_GATEWAY` | `promote-keep-set` script | Legacy-row fetches during promotion; optional, defaults to a dedicated (faster) gateway |
| `PROMOTE_CONCURRENCY`, `PROMOTE_RATE_LIMIT` | `promote-keep-set` script | Sweep concurrency (default 8) and requests/min against the gateway + B2 (default 600) |
| `ORIGIN` | api | Space Invaders origin base URL the `image_url` resolver falls back to for legacy (no `image_tier`) rows; defaults `https://api.space-invaders.com` |
| `B2_DOWNLOAD_BASE`, `B2_BUCKET` | api | Backblaze B2 download host and bucket name the `/i/:flash_id` redirect builds its tokened URL against |
| `B2_BUCKET_ID`, `B2_API_KEY_ID`, `B2_API_KEY` | api | Bucket id and a download-only key pair the api uses to mint scoped, prefix-limited download-authorization tokens server-side (the bucket itself is `allPrivate`, never public) |
| `API_KEY`, `TRUST_PROXY_HOPS`, `RATE_LIMIT_SIGNUP_PER_10MIN`, `RATE_LIMIT_IDENTIFICATION_PER_MIN`, `CORS_ORIGINS`, `GRAPHQL_INTROSPECTION` | api | Hardening knobs (see project `CLAUDE.md`) |
| `METRICS_PORT` | All | Prometheus metrics port |
| `LOKI_URL` | All (optional) | Loki URL for log shipping (e.g., `http://loki:3100`) |
| `PORT` | api | GraphQL API port (default: 4000) |

`agent-invaders` has its own set of env vars (Fireworks, Farcaster signer, Tavily, etc.) — see `.env.example`.

### Type Checking

```bash
# Check all projects
npm run typecheck   # every app, lib and script
npm test            # vitest across libs and apps
```

## Deployment

### Railway (flash-engine, image-engine, neynar-engine, api, agent-invaders)

All 5 apps deploy automatically on push to `main` via Railway's git integration. Each service is configured with:

- **Root directory:** `apps/<service-name>`
- **Dockerfile:** `apps/<service-name>/Dockerfile`
- **Watch paths:** `apps/<service-name>/**`, `libs/**`, `package.json`, `tsconfig.base.json`

Services connect to the existing Railway Postgres instance via internal networking. Each Dockerfile bundles its app with esbuild, marking `pg` (and `@neynar/nodejs-sdk` where used) `--external` rather than bundling them — see project `CLAUDE.md` for the build details.
