# flashcastr.services

Nx monorepo containing the Flashcastr microservices pipeline. Replaces the previous `invaders.producer` + `invaders.consumer` with 4 fully decoupled services communicating via RabbitMQ.

## Architecture

```
Space Invaders API
       |
  flash-engine         --> FLASH_RECEIVED { payload }
       | (RabbitMQ)
  image-engine         --> IMAGE_PINNED { payload, ipfs_cid }
       | (RabbitMQ)
  database-engine      --> FLASH_STORED { payload, ipfs_cid, db_info }
       | (RabbitMQ)
  neynar-engine        --> FLASH_CASTED { payload, ipfs_cid, db_info }
```

### Services

| Service | Role | Deploy |
|---------|------|--------|
| **flash-engine** | Cron-fetches flashes from Space Invaders API, publishes `FLASH_RECEIVED` | Railway |
| **image-engine** | Downloads images, pins to IPFS via Pinata, publishes `IMAGE_PINNED` | Digital Ocean |
| **database-engine** | Batch inserts flashes into Postgres, publishes `FLASH_STORED` | Railway |
| **neynar-engine** | Casts to Farcaster via Neynar SDK, publishes `FLASH_CASTED` + retry worker | Railway |

### RabbitMQ Topology

- **Exchange:** `flashcastr.events` (topic, durable)
- **Dead Letter Exchange:** `flashcastr.dlx` (topic, durable)
- **Queues:** `flash-engine.flash-received`, `image-engine.image-pinned`, `database-engine.flash-stored`, `neynar-engine.flash-casted`, `flashcastr.dead-letters`

All messages use a common envelope:

```typescript
interface MessageEnvelope<T> {
  id: string;              // UUID for idempotency
  timestamp: number;       // Unix epoch ms
  source: string;          // Service name
  type: string;            // Routing key
  version: string;         // Schema version
  correlationId: string;   // Traces a flash through the pipeline
  payload: T;
}
```

## Project Structure

```
flashcastr.services/
├── apps/
│   ├── flash-engine/          # Fetch from Space Invaders API
│   ├── image-engine/          # Download + pin to IPFS
│   ├── database-engine/       # Store in Postgres
│   └── neynar-engine/         # Cast to Farcaster
│
├── libs/
│   ├── shared-types/          # Flash, message envelopes, event constants
│   ├── rabbitmq/              # Publisher, consumer, topology setup
│   ├── database/              # PG pool, flashes/flashcastr DB classes
│   ├── proxy/                 # Proxy rotation for API requests
│   ├── metrics/               # Prometheus registry + HTTP server
│   ├── config/                # Env var helpers
│   ├── health/                # Health check server
│   ├── logger/                # Structured logging
│   └── crypto/                # AES-256-GCM decrypt (signer keys)
│
├── docker-compose.yml         # Local dev (RabbitMQ + Postgres + all services)
├── .env.example               # Environment variable reference
└── .github/workflows/
    └── deploy-image-engine.yml  # DO deploy via GitHub Action
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for local dev)

### Local Development

```bash
# Install dependencies
npm install

# Start infrastructure + all services locally
docker-compose up

# Or run a single service in dev mode
npx tsx --watch apps/flash-engine/src/main.ts
```

### Environment Variables

Copy `.env.example` to `.env.local` and fill in values:

```bash
cp .env.example .env.local
```

Key variables per service:

| Variable | Services | Description |
|----------|----------|-------------|
| `RABBITMQ_URL` | All | AMQP connection string |
| `DATABASE_URL` | database-engine, neynar-engine | Postgres connection string |
| `PINATA_JWT` | image-engine | Pinata API JWT for IPFS pinning |
| `PROXY_LIST` | flash-engine, image-engine | Comma-separated proxy URLs |
| `NEYNAR_API_KEY` | neynar-engine | Neynar API key for Farcaster |
| `SIGNER_ENCRYPTION_KEY` | neynar-engine | Hex key for decrypting signer UUIDs |
| `METRICS_PORT` | All | Prometheus metrics port (default: 9090) |

### Type Checking

```bash
# Check all projects
npx tsc --project apps/flash-engine/tsconfig.json --noEmit
npx tsc --project apps/image-engine/tsconfig.json --noEmit
npx tsc --project apps/database-engine/tsconfig.json --noEmit
npx tsc --project apps/neynar-engine/tsconfig.json --noEmit
```

## Deployment

### Railway (flash-engine, database-engine, neynar-engine)

These deploy automatically on push to `main` via Railway's git integration. Each service is configured with:

- **Root directory:** `apps/<service-name>`
- **Dockerfile:** `apps/<service-name>/Dockerfile`
- **Watch paths:** `apps/<service-name>/**`, `libs/**`, `package.json`, `tsconfig.base.json`

Services connect to the existing Railway Postgres and RabbitMQ instances via internal networking.

### Digital Ocean (image-engine)

Deploys via GitHub Action (`.github/workflows/deploy-image-engine.yml`) triggered on push to `main` when `apps/image-engine/**` or `libs/**` change.

Required GitHub secrets:
- `DIGITALOCEAN_ACCESS_TOKEN`
- `DO_REGISTRY_NAME`
- `DO_APP_ID`

## Migration from Old Architecture

The old system (`invaders.producer` + `invaders.consumer`) uses a single RabbitMQ queue `flash_images`. The new system uses separate queues under the `flashcastr.events` exchange. Both can run in parallel safely:

- Same Postgres database (ON CONFLICT handles overlap)
- Different RabbitMQ queues (no interference)
- **Rollback:** restart old services, they resume from where they left off

### Migration Steps

1. Deploy new services alongside old ones
2. Run neynar-engine in dry-run mode (verify without casting)
3. Compare flash counts over 24 hours
4. Enable casting in neynar-engine, disable in old producer
5. Shut down old producer + consumer
