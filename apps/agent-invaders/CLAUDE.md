# agent-invaders

LangGraph + TypeScript agent for the @flashcastr Farcaster account, living in the flashcastr.services monorepo. Node 20, ESM, `nodenext` imports with `.js` suffix, no code comments anywhere. Runs from source via `tsx` like the other apps; deps live in the root `package.json`.

## Layout

- `src/application.ts` composition root; `src/main.ts` server entry; `src/cli.ts` one-off commands (`digest`, `status`, `news`).
- `src/graphs/digest` daily cast graph (fan-out over sources with `Send`, compose → validate loop, publish).
- `src/graphs/conversation` mention/reply graph (`MessagesAnnotation` + `ToolNode`, thread id = `thread:<farcaster thread hash>`).
- `src/invaders` invader-spotter.art facade and parsers; fixtures under `tests/fixtures` are real page captures.
- `src/farcaster` gateway port + hub adapter (signs with `@farcaster/core`, submits to Neynar hub) + Neynar reader.
- `src/actions` Postgres action log and the logging decorator around the gateway.
- `src/memory/agentMemory.ts` the only place that knows store namespaces.
- `src/validation` chain of validators applied to every outgoing cast.

## Gotchas

- invader-spotter `listing.php` returns a 404 image unless the request carries the session cookie AND `Referer: cherche.php`. `InvaderSpotterSession` handles both; never call `fetch` on it directly.
- The search form takes city checkboxes by code; Paris must be sent as every `PA01..PA95` district (`searchFormCodesFor`). `numero` accepts `4; 12; 35-157`.
- `news.php` splits long entries over several `<p class='news'>` paragraphs and mixes several verbs in one line; kind is decided per anchor from the preceding text, inheriting across continuation paragraphs.
- Grounding: `GroundingValidator` rejects any invader ID absent from the run's evidence. Add IDs to evidence by returning them from tools, never by widening the allow-list.
- Checkpointer schema `langgraph`, store schema `langgraph_store`; both `setup()` on boot. App tables in `public` via `ensureSchema`.
- Fireworks is used through `ChatOpenAI` with `configuration.baseURL`; default model `accounts/fireworks/models/glm-5p3`.

## Commands

```bash
npm run typecheck -w @flashcastr/agent-invaders && npm test -w @flashcastr/agent-invaders
npm run status -w @flashcastr/agent-invaders -- PA_04 LDN_01
docker build -f apps/agent-invaders/Dockerfile .   # from repo root
```
