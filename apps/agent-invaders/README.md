# agent-invaders

LangGraph agent behind the `@flashcastr` Farcaster account. Every day it reads the invader-spotter.art catalogue changes plus a handful of web sources, writes one update cast into `/invaders`, and answers anyone who mentions or replies to it with catalogue-backed facts ("how's PA_04 doing?").

## What it does

- **Daily digest** (`DAILY_DIGEST_CRON`, UTC): fetches `news.php` from invader-spotter.art, looks up the current condition of the headline invaders, fans out over the news sources, composes one cast with GLM on Fireworks, validates it, publishes it, and remembers it.
- **Conversations**: Neynar webhook (`POST /webhooks/neynar`, `cast.created`) plus a polling fallback over the account's notifications. Each thread is a LangGraph thread checkpointed in Postgres, so follow-ups keep their context. The model has tools to look up invader status, list recent catalogue events, search news, store community corrections, and remember facts about the person.
- **Accuracy**: every invader ID in an outgoing cast must appear in the source data for that run (catalogue events, tool results or the inbound text), otherwise the draft is sent back for rewrite and finally dropped. Facts about an invader come only from the invader-spotter search form, never from the model.

## Sources

| Source | How |
|---|---|
| invader-spotter.art news | `news.php`, parsed per invader with the change kind (destruction, degradation, reactivation, restoration, addition, alert, status update) |
| invader-spotter.art status | `listing.php` search form, session cookie + referer, all conditions and point values ticked, Paris expanded to every arrondissement |
| Google News RSS | query for the artist, mosaics and FlashInvaders |
| space-invaders.com/news | official announcements |
| GraffitiStreet tag feed | RSS |
| `EXTRA_RSS_FEEDS` | comma separated RSS/Atom URLs |
| Tavily | only if `TAVILY_API_KEY` is set |

## Persistence

- `langgraph.*` schema: `PostgresSaver` checkpoints (one thread per digest date and per Farcaster thread).
- `langgraph_store.*` schema: `PostgresStore` long-term memory. Namespaces: `seen/<source>`, `invader-status`, `digests`, `corrections`, `users`.
- `action_log`: every side effect and decision (source fetches, validations, publishes, likes, skips, failures) with outcome and detail.
- `inbound_casts`: idempotent claim of each inbound cast, per-author rate limiting, final status.

## Design patterns

- **Strategy**: `NewsSource` implementations (`RssFeedSource`, `OfficialSiteNewsSource`, `TavilySearchSource`) selected by `SourceRegistry`.
- **Facade**: `InvaderSpotterClient` hides the session cookie, referer and form encoding of invader-spotter.art; `AgentMemory` hides store namespaces.
- **Adapter**: `HubFarcasterGateway` adapts `@farcaster/core` message signing and hub submission to the `FarcasterGateway` port; `NeynarReader` adapts the Neynar SDK to `FarcasterReader`.
- **Decorator**: `ActionLoggingFarcasterGateway` records every publish and like around the real gateway.
- **Chain of Responsibility**: `CastValidator` links (`LengthValidator`, `GroundingValidator`, `ForbiddenPhraseValidator`).
- **Command**: `DigestCommand` and `ReplyCommand` wrap a graph run so the scheduler, the webhook and the CLI trigger the same unit of work.
- **Factory Method**: `FireworksModelFactory` builds the chat model per purpose.

## Run

From the monorepo root, with the `agent-invaders` section of `.env.example` filled into `.env`:

```bash
npm install
npm run dev -w @flashcastr/agent-invaders               # http server + scheduler + poller
npm run digest -w @flashcastr/agent-invaders            # run today's digest once
npm run status -w @flashcastr/agent-invaders -- PA_04   # live status lookup, no DB needed
npm run news -w @flashcastr/agent-invaders              # latest catalogue events
npm test -w @flashcastr/agent-invaders
```

Manual digest trigger on a running instance:

```bash
curl -X POST https://<host>/admin/digest -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Deploy on Railway

1. In the existing flashcastr Railway project, create service `agent-invaders` from the GitHub repo with root directory `/` and config file `apps/agent-invaders/railway.json` (Dockerfile path, watch patterns, `/health`).
2. Set `DATABASE_URL` to the project's Postgres reference (`${{Postgres.DATABASE_URL}}`). Schemas `langgraph`, `langgraph_store` and tables `action_log`, `inbound_casts` are created on boot.
3. Set the variables from `.env.example`. `FARCASTER_SIGNER_PRIVATE_KEY` is the Ed25519 signer key registered on-chain for `FARCASTER_FID`; boot fails if the hub does not list it.
4. Create a Neynar webhook for `cast.created` filtered on `mentioned_fids` and `parent_author_fids` = the account fid, pointing at `https://<host>/webhooks/neynar`, and put its secret in `NEYNAR_WEBHOOK_SECRET`. Without it the poller alone handles mentions.
