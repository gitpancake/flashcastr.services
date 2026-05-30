// ─── Module-level TTL cache ──────────────────────────────────────────────────
// Reduces HTTP round-trips to the context service by caching read/list results
// for 5 minutes. Writes bypass the cache entirely. Invalidated on CONFIG_UPDATED.

const _cache = new Map<string, { value: unknown; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

function getCached<T>(key: string): T | undefined {
  const hit = _cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) { _cache.delete(key); return undefined; }
  return hit.value as T;
}

function setCached(key: string, value: unknown): void {
  _cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/** Clear the entire context TTL cache. Call before re-reading settings after CONFIG_UPDATED. */
export function invalidateContextCache(): void {
  _cache.clear();
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentContext {
  role: string | null;
  domain: string | null;
  userNotes: string | null;
  learned: Record<string, string>;
}

export interface UserContext {
  profile: string | null;
  constraints: string | null;
  tools: string | null;
  preferences: Record<string, string>;
  status: Record<string, string>;
  goals: Record<string, string>;
}

// ─── OpenViking direct client ────────────────────────────────────────────────
// This service talks to OpenViking directly — it holds OV creds itself, with no
// service-context proxy. Transport ported from service-context/src/ov-client.ts.

function getOvUrl(): string {
  const url = process.env.OPENVIKING_URL;
  if (!url) throw new Error('OPENVIKING_URL not set — cannot access context store');
  return url.replace(/\/$/, '');
}

function getOvHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = process.env.OPENVIKING_API_KEY;
  if (apiKey) headers['X-API-Key'] = apiKey;
  const user = process.env.OPENVIKING_BASIC_USER;
  const pass = process.env.OPENVIKING_BASIC_PASS;
  if (user && pass) {
    headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return headers;
}

// ── Retry wrapper ───────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [100, 500];

// Retries on transport errors (TypeError from undici) and 5xx responses.
// 4xx are real errors — they reflect a problem with the request, not the connection.
async function withRetry<T>(
  fn: () => Promise<T>,
  fallback: T,
  label: string,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      const isLast = attempt === maxAttempts;
      if (isLast) {
        console.warn(`[context-store] ${label}: attempt ${attempt}/${maxAttempts} failed — ${(err as Error).message}`);
        return fallback;
      }
      console.warn(`[context-store] ${label}: attempt ${attempt}/${maxAttempts} after ${(err as Error).message}`);
      const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return fallback;
}

// Raw OV read: try direct + {uri}/content.md, then reassemble chunked docs.
async function ovReadDirect(uri: string): Promise<string | null> {
  return withRetry(
    async () => {
      const uris = [uri, `${uri}/content.md`];
      for (const u of uris) {
        const params = new URLSearchParams({ uri: u });
        const res = await fetch(`${getOvUrl()}/api/v1/content/read?${params}`, { headers: getOvHeaders() });
        if (!res.ok) {
          if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
          continue; // 404 etc — try next candidate
        }
        const data = await res.json() as { result?: string };
        if (data.result) return data.result;
      }

      // OV chunks large documents into subdirectories — reassemble leaf files.
      const listParams = new URLSearchParams({ uri, recursive: 'true' });
      const listRes = await fetch(`${getOvUrl()}/api/v1/fs/ls?${listParams}`, { headers: getOvHeaders() });
      if (!listRes.ok) return null;

      const listData = await listRes.json() as { result?: Array<{ uri: string; isDir: boolean }> };
      const leaves = (listData.result ?? []).filter(e => !e.isDir);
      if (leaves.length === 0) return null;

      const chunks = await Promise.all(leaves.map(async (leaf) => {
        const leafUri = leaf.uri.replace(/^viking:\/\//, '/');
        const params = new URLSearchParams({ uri: leafUri });
        const res = await fetch(`${getOvUrl()}/api/v1/content/read?${params}`, { headers: getOvHeaders() });
        if (!res.ok) return '';
        const data = await res.json() as { result?: string };
        return data.result ?? '';
      }));

      return chunks.filter(Boolean).join('\n\n') || null;
    },
    null,
    `ov read ${uri}`,
  );
}

// OV add_resource uses `path` for content and `to` for the destination URI,
// and rejects writes to existing URIs — delete first to allow updates.
async function ovWriteDirect(content: string, to: string): Promise<{ ok: boolean; status?: number }> {
  try {
    await fetch(`${getOvUrl()}/api/v1/fs?uri=${encodeURIComponent(to)}&recursive=true`, {
      method: 'DELETE',
      headers: getOvHeaders(),
    }).catch(() => {}); // ignore — resource may not exist yet

    const res = await fetch(`${getOvUrl()}/api/v1/resources`, {
      method: 'POST',
      headers: getOvHeaders(),
      body: JSON.stringify({ path: content, to }),
    });
    if (!res.ok) console.warn(`[context-store] ov write ${to}: HTTP ${res.status}`);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.warn(`[context-store] ov write ${to}: ${(err as Error).message}`);
    return { ok: false };
  }
}

async function ovDeleteDirect(uri: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(`${getOvUrl()}/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=true`, {
      method: 'DELETE',
      headers: getOvHeaders(),
    });
    const ok = res.ok || res.status === 404; // 404 fine — may not exist
    if (!ok) console.warn(`[context-store] ov delete ${uri}: HTTP ${res.status}`);
    return { ok, status: res.status };
  } catch (err) {
    console.warn(`[context-store] ov delete ${uri}: ${(err as Error).message}`);
    return { ok: false };
  }
}

// OV stores documents as directories containing content.md — return the .md
// directory URIs (the documents), not raw files.
async function ovListDirect(uri: string): Promise<string[]> {
  return withRetry(
    async () => {
      const params = new URLSearchParams({ uri });
      const res = await fetch(`${getOvUrl()}/api/v1/fs/ls?${params}`, { headers: getOvHeaders() });
      if (!res.ok) {
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        return []; // 404 etc — treat as empty
      }
      const data = await res.json() as { result?: Array<{ uri: string; isDir: boolean; rel_path?: string }> };
      return (data.result ?? [])
        .filter(e => {
          if (!e.isDir) return false;
          const name = e.rel_path ?? e.uri.split('/').pop() ?? '';
          return name.endsWith('.md');
        })
        .map(e => e.uri.replace(/^viking:\/\//, '/'));
    },
    [],
    `ov list ${uri}`,
  );
}

async function ovRead(uri: string): Promise<string | null> {
  const cacheKey = `read:${uri}`;
  const hit = getCached<string | null>(cacheKey);
  if (hit !== undefined) return hit;
  const result = await ovReadDirect(uri);
  // Only cache successful reads — null (missing/error) should not be locked in for 5min
  if (result !== null) setCached(cacheKey, result);
  return result;
}

async function ovWrite(content: string, to: string): Promise<{ ok: boolean; status?: number }> {
  // Writes are never cached — go direct and invalidate any cached read for this uri.
  _cache.delete(`read:${to}`);
  return ovWriteDirect(content, to);
}

async function ovDelete(uri: string): Promise<{ ok: boolean; status?: number }> {
  _cache.delete(`read:${uri}`);
  _cache.delete(`list:${uri.substring(0, uri.lastIndexOf('/'))}`);
  return ovDeleteDirect(uri);
}

async function ovList(uri: string): Promise<string[]> {
  const cacheKey = `list:${uri}`;
  const hit = getCached<string[]>(cacheKey);
  if (hit !== undefined) return hit;
  const result = await ovListDirect(uri);
  // Don't cache empty arrays — could be a transient failure, not a genuinely empty directory
  if (result.length > 0) setCached(cacheKey, result);
  return result;
}

// ─── Low-level OV access (for agents that manage their own OV paths) ────────

/**
 * Read raw content from an OV path. Returns null if not found or on error.
 * Used by agents that store structured data at known paths (e.g. knowledge base).
 */
export async function readFromOV(path: string): Promise<string | null> {
  return ovRead(path);
}

/**
 * Write raw content to an OV path.
 * Used by agents that manage structured data at known paths (e.g. knowledge base).
 */
export async function writeToOV(path: string, content: string): Promise<void> {
  const result = await ovWrite(content, path);
  if (!result.ok) {
    throw new Error(`OV write failed for ${path} (HTTP ${result.status ?? 'unknown'})`);
  }
}

/**
 * Delete an OV resource by path. 404 is treated as success (already gone).
 * Used by agents that manage structured data at known paths (e.g. knowledge base).
 */
export async function deleteFromOV(path: string): Promise<void> {
  const result = await ovDelete(path);
  if (!result.ok) {
    throw new Error(`OV delete failed for ${path} (HTTP ${result.status ?? 'unknown'})`);
  }
}

/**
 * List child URIs under an OV path. Returns an empty array if not found or on error.
 */
export async function listFromOV(path: string): Promise<string[]> {
  return ovList(path);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load an agent's context from OpenViking.
 * Reads role.md, domain.md, user-notes.md, and any files in learned/.
 * Returns null fields when documents don't exist (graceful for new agents).
 */
export async function loadAgentContext(agentName: string): Promise<AgentContext> {
  const base = `/agent/${agentName}`;

  const [role, domain, userNotes] = await Promise.all([
    ovRead(`${base}/role.md`),
    ovRead(`${base}/domain.md`),
    ovRead(`${base}/user-notes.md`),
  ]);

  const learned: Record<string, string> = {};
  const learnedFiles = await ovList(`${base}/learned`);
  if (learnedFiles.length > 0) {
    const contents = await Promise.all(learnedFiles.map(uri => ovRead(uri)));
    for (let i = 0; i < learnedFiles.length; i++) {
      const filename = learnedFiles[i].split('/').pop() ?? '';
      if (contents[i]) learned[filename] = contents[i]!;
    }
  }

  return { role, domain, userNotes, learned };
}

/**
 * Load shared user context from OpenViking.
 * Reads profile, constraints, tools, and all files under preferences/, status/, goals/.
 */
export async function loadUserContext(): Promise<UserContext> {
  // Sequential on cold start to avoid stampeding service-context with parallel connections.
  // The 5-min TTL cache makes subsequent calls free.
  const profile = await ovRead('/user/profile.md');
  const constraints = await ovRead('/user/constraints.md');
  const tools = await ovRead('/user/tools.md');

  const [preferences, status, goals] = await Promise.all([
    loadDirectory('/user/preferences'),
    loadDirectory('/user/status'),
    loadDirectory('/user/goals'),
  ]);

  return { profile, constraints, tools, preferences, status, goals };
}


/**
 * Load all user settings from OV as a flat key-value map.
 * Parses profile.md and all preferences/ files using the key: value line format.
 * Returns an empty object if OV is unreachable.
 */
export async function loadSettingsFromOV(): Promise<Record<string, string>> {
  const userCtx = await loadUserContext();
  const settings: Record<string, string> = {};

  const parseKV = (text: string) => {
    for (const line of text.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value && !key.startsWith('#')) settings[key] = value;
    }
  };

  if (userCtx.profile) parseKV(userCtx.profile);
  for (const content of Object.values(userCtx.preferences)) {
    parseKV(content);
  }

  return settings;
}

/**
 * Write an observation from an agent's nightly refinement to OpenViking.
 * OV is the sole source of truth — no PG mirror.
 *
 * @param _db Unused — kept for backward compat with existing call sites.
 */
export async function writeAgentObservation(
  _db: any,
  agentName: string,
  filename: string,
  content: string,
): Promise<void> {
  const ovPath = `/agent/${agentName}/learned/${filename}`;
  const result = await ovWrite(content, ovPath);
  if (!result.ok) {
    throw new Error(`OV write failed for ${ovPath} (HTTP ${result.status ?? 'unknown'})`);
  }
}

/**
 * Write consolidated user context (called by orchestrator after cross-referencing observations).
 */
export async function writeUserContext(
  filename: string,
  content: string,
): Promise<void> {
  const ovPath = `/user/${filename}`;
  const result = await ovWrite(content, ovPath);
  if (!result.ok) {
    throw new Error(`OV write failed for ${ovPath} (HTTP ${result.status ?? 'unknown'})`);
  }
}

/**
 * Read all agent observations from OpenViking (for orchestrator consolidation).
 * Lists agent learned directories and reads each observation file.
 *
 * @param _db Unused — kept for backward compat.
 */
export async function readAllObservations(
  _db?: any,
): Promise<Array<{ agentName: string; filename: string; content: string }>> {
  const agentDirs = await ovList('/agent');
  if (agentDirs.length === 0) return [];

  // Parallel: list + read learned files for all agents concurrently
  const agentResults = await Promise.all(
    agentDirs.map(async (agentDir) => {
      const agentName = agentDir.split('/').pop()?.replace(/\.md$/, '') ?? '';
      if (!agentName) return [];

      const learnedFiles = await ovList(`${agentDir}/learned`);
      const contents = await Promise.all(learnedFiles.map(uri => ovRead(uri)));

      return learnedFiles
        .map((fileUri, i) => ({
          agentName,
          filename: fileUri.split('/').pop() ?? '',
          content: contents[i],
        }))
        .filter((r): r is { agentName: string; filename: string; content: string } => !!r.content);
    }),
  );

  return agentResults.flat();
}

// ─── Observation helpers (LOS-348 — gateway → OV read-only) ────────────────

export interface AgentObservation {
  filename: string;
  content: string;
  /** Best-effort extraction from filename prefix — OV's convention is
   *  `YYYY-MM-DD_<topic>.md`. Falls back to null if the prefix is missing. */
  observedAt: string | null;
}

function parseObservedAt(filename: string): string | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Read the most recent observations for an agent from OV.
 * Sorted by filename descending (OV convention: `YYYY-MM-DD_...`) — newest first.
 */
export async function loadAgentObservations(
  agent: string,
  limit = 5,
): Promise<AgentObservation[]> {
  const files = await ovList(`/agent/${agent}/learned`);
  if (files.length === 0) return [];

  const sorted = [...files].sort((a, b) => b.localeCompare(a)).slice(0, limit);
  const contents = await Promise.all(sorted.map(uri => ovRead(uri)));

  return sorted
    .map((uri, i) => {
      const filename = uri.split('/').pop() ?? '';
      const content = contents[i];
      if (!content) return null;
      return { filename, content, observedAt: parseObservedAt(filename) };
    })
    .filter((x): x is AgentObservation => x !== null);
}

/** Count observation files stored for an agent. Used by the /agents page counter. */
export async function countAgentObservations(agent: string): Promise<number> {
  const files = await ovList(`/agent/${agent}/learned`);
  return files.length;
}

/** Sum of observations across every agent namespace under `/agent/*`. */
export async function countAllObservations(): Promise<number> {
  const agentDirs = await ovList('/agent');
  if (agentDirs.length === 0) return 0;

  const counts = await Promise.all(agentDirs.map(async (dir) => {
    const learned = await ovList(`${dir}/learned`);
    return learned.length;
  }));

  return counts.reduce((sum, n) => sum + n, 0);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadDirectory(basePath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const files = await ovList(basePath);
  if (files.length === 0) return result;

  const contents = await Promise.all(files.map(uri => ovRead(uri)));
  for (let i = 0; i < files.length; i++) {
    const key = files[i].split('/').pop()?.replace(/\.md$/, '') ?? '';
    if (contents[i]) result[key] = contents[i]!;
  }
  return result;
}
