/**
 * Authenticated scraper for awazleon.space/ListNews.php (HEN-583).
 *
 * Auth flow:
 *   POST https://awazleon.space/login_D.php
 *     Content-Type: application/json
 *     Body: { email, password, lang: 'en', device: 'D' }
 *     Success → JSON {success:true, loc, ...} + Set-Cookie: auth_token=<value>
 *     Failure → JSON {success:false, message}
 *   GET  https://awazleon.space/ListNews.php
 *     Cookie: auth_token=<value>
 *     Stale session → 302 to /index.php with auth_token=deleted; treat as login failure.
 *
 * Single cookie, no jar dep — capture from Set-Cookie, replay on Cookie header.
 */
const BASE = 'https://awazleon.space';
// HEN-589: live login endpoint is /login_D.php — original recon (HEN-583)
// guessed /A_login_U.php and the prod tick failed every run with a 302 on ListNews
// because the login POST wasn't actually setting a session cookie.
const LOGIN_URL = `${BASE}/login_D.php`;
const LIST_URL = `${BASE}/ListNews.php`;
const USER_AGENT = 'LifeOS-Flashcastr/1.0 (invader content agent)';

export interface AwazleonItem {
  url: string;            // canonical URL of the news entry on awazleon
  title: string;
  body: string;            // raw text, no markdown, trimmed
  publishedAt: string | null;  // 'YYYY-MM-DD' if parseable
}

interface LoginResult {
  authCookie: string;       // 'auth_token=<value>' ready to put on Cookie header
}

export async function scrapeAwazleon(user: string, pass: string): Promise<AwazleonItem[]> {
  const session = await login(user, pass);
  const html = await fetchListNews(session.authCookie);
  return parseListNewsHtml(html);
}

// ─── Login ────────────────────────────────────────────────────────────────

async function login(user: string, pass: string): Promise<LoginResult> {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
    },
    body: JSON.stringify({ email: user, password: pass, lang: 'en', device: 'D' }),
  });

  // Login endpoint always returns 200 with a JSON body — even on failure.
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    throw new Error('awazleon login failed: unreadable response body');
  }

  let parsed: { success?: boolean; message?: string } | null = null;
  try {
    parsed = JSON.parse(bodyText) as { success?: boolean; message?: string };
  } catch {
    throw new Error('awazleon login failed: response not JSON');
  }

  if (!parsed?.success) {
    // Don't leak the password — message can be safely surfaced.
    const detail = parsed?.message ? ` (${parsed.message})` : '';
    throw new Error(`awazleon login failed${detail}`);
  }

  const setCookie = res.headers.get('set-cookie');
  const authCookie = extractAuthToken(setCookie);
  if (!authCookie) {
    throw new Error('awazleon login failed: no auth_token in Set-Cookie');
  }
  return { authCookie };
}

/**
 * Pull the `auth_token=<value>` pair out of a Set-Cookie header.
 * `fetch` collapses multiple cookies into one comma-separated header; we only
 * care about the first `auth_token=...` segment up to the next `;`.
 */
function extractAuthToken(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/auth_token=([^;,\s]+)/);
  if (!match || match[1] === 'deleted') return null;
  return `auth_token=${match[1]}`;
}

// ─── Fetch list page ──────────────────────────────────────────────────────

async function fetchListNews(authCookie: string): Promise<string> {
  const res = await fetch(LIST_URL, {
    redirect: 'manual',
    headers: {
      'Cookie': authCookie,
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
    },
  });

  // Stale/invalid session → 302 back to /index.php. Treat as auth failure.
  if (res.status >= 300 && res.status < 400) {
    throw new Error('awazleon login failed: ListNews.php redirected (stale session)');
  }
  if (!res.ok) {
    throw new Error(`awazleon login failed: ListNews.php returned ${res.status}`);
  }

  const html = await res.text();
  if (looksLikeLoginPage(html)) {
    throw new Error('awazleon login failed: ListNews.php returned login page');
  }
  return html;
}

function looksLikeLoginPage(html: string): boolean {
  // login_D.php has both an id="loginForm" and a password input; either alone
  // is too generic, but the combination is a reliable tell.
  return /id=["']loginForm["']/i.test(html) && /name=["']password["']/i.test(html);
}

// ─── Parse ────────────────────────────────────────────────────────────────

/**
 * Parse ListNews.php HTML into structured items.
 *
 * The rendered markup was not observable during recon (auth-gated). The parser
 * tries the two shapes most common for PHP/Bootstrap fan news pages:
 *  1. Article / card blocks (<article>, <div class="card">)
 *  2. Tabulator-style <tr> rows (this site uses Tabulator JS)
 *
 * Both shapes reduce to "find anchor → title; everything-after-anchor → body;
 * any date in the block → publishedAt". Returns [] if neither shape matches.
 */
export function parseListNewsHtml(html: string): AwazleonItem[] {
  const articlePattern = /<(article|div)[^>]*class=["'][^"']*(?:\bcard\b|news|item)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const articles = collectBlocks(html, articlePattern, 2);
  const items = articles.map(extractItem).filter((x): x is AwazleonItem => x !== null);
  if (items.length > 0) return dedupeByUrl(items);

  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows = collectBlocks(html, rowPattern, 1);
  return dedupeByUrl(rows.map(extractItem).filter((x): x is AwazleonItem => x !== null));
}

function collectBlocks(html: string, pattern: RegExp, captureGroup: number): string[] {
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    const block = m[captureGroup];
    if (block) blocks.push(block);
  }
  return blocks;
}

function extractItem(block: string): AwazleonItem | null {
  const linkMatch = block.match(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!linkMatch) return null;
  const title = stripHtml(linkMatch[2]!).trim();
  if (!title) return null;

  const tailIdx = block.indexOf(linkMatch[0]) + linkMatch[0].length;
  return {
    url: absolutize(linkMatch[1]!),
    title,
    body: stripHtml(block.slice(tailIdx)).trim(),
    publishedAt: extractDate(block),
  };
}

/**
 * Pull a YYYY-MM-DD date out of a block. Accepts:
 *  - ISO 'YYYY-MM-DD'
 *  - 'DD/MM/YYYY' or 'DD-MM-YYYY' (French sites default to day-first)
 *  - <time datetime="YYYY-MM-DD..."> attribute
 * Returns null if nothing parseable found.
 */
function extractDate(block: string): string | null {
  const isoTime = block.match(/<time[^>]*datetime=["'](\d{4}-\d{2}-\d{2})/i);
  if (isoTime) return isoTime[1]!;

  const iso = block.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const dmy = block.match(/\b(\d{2})[/-](\d{2})[/-](\d{4})\b/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;

  return null;
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

function absolutize(href: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('/')) return `${BASE}${href}`;
  return `${BASE}/${href}`;
}

function dedupeByUrl(items: AwazleonItem[]): AwazleonItem[] {
  const seen = new Set<string>();
  const out: AwazleonItem[] = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}
