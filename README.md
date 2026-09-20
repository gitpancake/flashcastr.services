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
| **image-engine** | `JobWorker` claims `pin` jobs, downloads + pins images to IPFS via Pinata, enqueues `cast` jobs | Railway |
| **neynar-engine** | `JobWorker` claims `cast` jobs, casts to Farcaster via Neynar SDK, retry worker for failed casts | Railway |
| **api** | GraphQL API (Apollo Server 5) with `LISTEN`/`NOTIFY`-backed WebSocket subscriptions | Railway |
| **agent-invaders** | LangGraph agent (mentions, daily digest) — no `@flashcastr/*` lib imports | Railway |

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
| `PINATA_JWT` | image-engine | Pinata API JWT for IPFS pinning |
| `CONSUMER_CONCURRENCY`, `CONSUMER_RATE_LIMIT`, `CONSUMER_MAX_ATTEMPTS` | image-engine | `pin`-job worker concurrency/rate limit/max attempts |
| `NEYNAR_API_KEY` | neynar-engine, agent-invaders | Neynar API key for Farcaster |
| `SIGNER_ENCRYPTION_KEY` | neynar-engine | Hex key for decrypting signer UUIDs |
| `RETRY_INTERVAL_MS` | neynar-engine | Failed-cast retry worker interval |
| `CAST_JOB_CONCURRENCY`, `CAST_JOB_LEASE_MS`, `CAST_JOB_MAX_ATTEMPTS`, `CAST_JOB_POLL_INTERVAL_MS` | neynar-engine | `cast`-job worker tuning |
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
