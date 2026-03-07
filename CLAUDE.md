# flashcastr.services

Nx monorepo with 4 microservices for the Flashcastr pipeline.

## Quick Reference

### Workspace Layout

- `apps/` — 4 deployable services (flash-engine, image-engine, database-engine, neynar-engine)
- `libs/` — 9 shared libraries (shared-types, rabbitmq, database, proxy, metrics, config, health, logger, crypto)
- All imports between libs use `@flashcastr/<lib-name>` (resolved via npm workspaces + `customConditions`)

### Tech Stack

- **Runtime:** Node.js 20, TypeScript (strict mode, `nodenext` modules)
- **Message bus:** RabbitMQ (topic exchange `flashcastr.events`, DLQ via `flashcastr.dlx`)
- **Database:** PostgreSQL (shared between database-engine and neynar-engine)
- **IPFS:** Pinata API
- **Farcaster:** Neynar SDK (`@neynar/nodejs-sdk`)
- **Monitoring:** Prometheus (`prom-client`)
- **Build:** Nx workspace with npm workspaces

### Common Commands

```bash
npm install                                              # Install deps
npx tsx --watch apps/<service>/src/main.ts                # Dev mode for a service
npx tsc --project apps/<service>/tsconfig.json --noEmit   # Type-check a service
docker-compose up                                        # Run everything locally
```

### Message Flow

```
flash-engine  --FLASH_RECEIVED-->  image-engine  --IMAGE_PINNED-->  database-engine  --FLASH_STORED-->  neynar-engine  --FLASH_CASTED-->
```

All messages use `MessageEnvelope<T>` from `@flashcastr/shared-types` with `id`, `correlationId`, `source`, `type`, `version`, `timestamp`, `payload`.

### Database Tables

| Table | Used by | Purpose |
|-------|---------|---------|
| `flashes` | database-engine, neynar-engine | All flash records with `ipfs_cid` |
| `flashcastr_flashes` | neynar-engine | Tracks which flashes were cast (flash_id, user_fid, cast_hash) |
| `flashcastr_users` | neynar-engine | Registered users (fid, username, encrypted signer_uuid, auto_cast) |

### RabbitMQ Topology

Defined in `libs/rabbitmq/src/topology.ts`. Exchange: `flashcastr.events` (topic). Queues:
- `flash-engine.flash-received` (routing key: `flash.received`)
- `image-engine.image-pinned` (routing key: `image.pinned`)
- `database-engine.flash-stored` (routing key: `flash.stored`)
- `neynar-engine.flash-casted` (routing key: `flash.casted`)
- `flashcastr.dead-letters` (routing key: `*.dead`)

All queues have DLQ via `x-dead-letter-exchange: flashcastr.dlx` and `x-max-length: 100000`.

### Key Design Decisions

- **No temporal coupling:** Old system waited 3 min between storing and casting. New system is fully event-driven — neynar-engine only receives messages after IPFS CID is populated.
- **Idempotency:** DB uses `ON CONFLICT DO UPDATE`, Pinata deduplicates by content hash, neynar-engine checks for existing `cast_hash` before casting.
- **Circuit breakers:** image-engine has IPFS circuit breaker (opens after 30 consecutive failures, resets after 5 min).
- **Batch processing:** database-engine accumulates messages and batch-inserts (configurable `BATCH_SIZE`, default 50).
- **Retry:** neynar-engine runs a periodic retry worker (every 5 min) for failed casts from last 7 days.

### Shared Libraries

| Library | Path | Key Exports |
|---------|------|-------------|
| `@flashcastr/shared-types` | `libs/shared-types` | `Flash`, `FlashcastrFlash`, `FlashcastrUser`, `MessageEnvelope`, payload types, `EVENTS` |
| `@flashcastr/rabbitmq` | `libs/rabbitmq` | `FlashcastrPublisher`, `FlashcastrConsumer`, `setupTopology`, `QUEUES`, `ROUTING_KEYS`, `EXCHANGES` |
| `@flashcastr/database` | `libs/database` | `getPool`, `closePool`, `PostgresFlashesDb`, `FlashcastrFlashesDb`, `FlashcastrUsersDb` |
| `@flashcastr/proxy` | `libs/proxy` | `ProxyRotator` (supports Oxylabs, failure tracking, rotation) |
| `@flashcastr/metrics` | `libs/metrics` | `createMetricsRegistry`, `startMetricsServer`, re-exports `Counter`, `Gauge`, `Histogram` |
| `@flashcastr/config` | `libs/config` | `loadConfig`, `requireEnv`, `optionalEnv`, `intEnv` |
| `@flashcastr/health` | `libs/health` | `startHealthServer` |
| `@flashcastr/logger` | `libs/logger` | `createLogger` |
| `@flashcastr/crypto` | `libs/crypto` | `decrypt` (AES-256-GCM) |

### Deployment

- **Railway:** flash-engine, database-engine, neynar-engine — auto-deploy on push to main with watch paths
- **Digital Ocean:** image-engine — GitHub Action at `.github/workflows/deploy-image-engine.yml`
- **Dockerfiles:** each service has its own at `apps/<service>/Dockerfile` (multi-stage, node:20-slim)
- **Infrastructure:** Existing Railway project has Postgres + RabbitMQ already running

### Environment Variables

See `.env.example` for full list. Critical per-service:
- **flash-engine:** `RABBITMQ_URL`, `PROXY_LIST`
- **image-engine:** `RABBITMQ_URL`, `PINATA_JWT`, `PROXY_LIST`, `CONSUMER_CONCURRENCY`
- **database-engine:** `RABBITMQ_URL`, `DATABASE_URL`, `BATCH_SIZE`, `DB_POOL_MAX`
- **neynar-engine:** `RABBITMQ_URL`, `DATABASE_URL`, `NEYNAR_API_KEY`, `SIGNER_ENCRYPTION_KEY`

### Code Lineage

This codebase was split from:
- `invaders.producer` — flash-engine (API fetching), neynar-engine (Farcaster casting), parts of database-engine
- `invaders.consumer` — image-engine (image download + IPFS pinning), parts of database-engine (batch updates)

<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## Nx Guidelines

- Prefer running tasks through `nx` (e.g., `npx nx build flash-engine`)
- Prefix nx commands with `npx` to avoid global CLI issues
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`

<!-- nx configuration end-->
