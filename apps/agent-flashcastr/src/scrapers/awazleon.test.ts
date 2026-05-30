import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { scrapeAwazleon, parseListNewsHtml } from './awazleon.js';

// ─── fetch mock ───────────────────────────────────────────────────────────

interface MockResponseSpec {
  status?: number;
  ok?: boolean;
  body?: string;
  setCookie?: string | null;
}

function mockResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  const ok = spec.ok ?? (status >= 200 && status < 300);
  const headers = new Map<string, string>();
  if (spec.setCookie) headers.set('set-cookie', spec.setCookie);
  return {
    ok,
    status,
    text: async () => spec.body ?? '',
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
  } as unknown as Response;
}

interface FetchCall { url: string; init?: RequestInit }
let fetchCalls: FetchCall[];
let fetchHandler: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  fetchCalls = [];
  fetchHandler = () => mockResponse({ status: 500, body: 'unmocked' });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(fetchHandler(url, init));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Login flow ───────────────────────────────────────────────────────────

describe('scrapeAwazleon login', () => {
  it('captures auth_token cookie from successful login and replays on ListNews', async () => {
    const sampleHtml = `
      <article class="card">
        <a href="/news/123">First post</a>
        <time datetime="2026-04-15">15/04/2026</time>
        <p>Body text here.</p>
      </article>
    `;

    fetchHandler = (url) => {
      if (url.includes('login_D.php')) {
        return mockResponse({
          status: 200,
          body: JSON.stringify({ success: true, loc: 'home_D.php', action: 'op', user: { id: 1 } }),
          setCookie: 'auth_token=abc123xyz; Path=/; HttpOnly; Secure; SameSite=Lax',
        });
      }
      if (url.includes('ListNews.php')) {
        return mockResponse({ status: 200, body: sampleHtml });
      }
      return mockResponse({ status: 404 });
    };

    const items = await scrapeAwazleon('user@example.com', 'secret');

    // Login then list, in order
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]!.url).toBe('https://awazleon.space/login_D.php');
    expect(fetchCalls[1]!.url).toBe('https://awazleon.space/ListNews.php');

    // Login body shape
    const loginBody = JSON.parse(fetchCalls[0]!.init!.body as string);
    expect(loginBody).toMatchObject({ email: 'user@example.com', password: 'secret', device: 'D' });

    // ListNews replays the cookie
    const listHeaders = fetchCalls[1]!.init!.headers as Record<string, string>;
    expect(listHeaders.Cookie).toBe('auth_token=abc123xyz');

    // Parsed item
    expect(items).toEqual([{
      url: 'https://awazleon.space/news/123',
      title: 'First post',
      body: expect.stringContaining('Body text here.'),
      publishedAt: '2026-04-15',
    }]);
  });

  it('throws "awazleon login failed" when login JSON returns success=false', async () => {
    fetchHandler = (url) => {
      if (url.includes('login_D.php')) {
        return mockResponse({
          status: 200,
          body: JSON.stringify({ success: false, message: 'Invalid username/email' }),
        });
      }
      return mockResponse({ status: 404 });
    };

    await expect(scrapeAwazleon('user', 'wrong')).rejects.toThrow(/awazleon login failed/);
    // Crucially: never hit ListNews when login fails.
    expect(fetchCalls.find((c) => c.url.includes('ListNews.php'))).toBeUndefined();
  });

  it('throws when ListNews returns a 302 redirect (stale session)', async () => {
    fetchHandler = (url) => {
      if (url.includes('login_D.php')) {
        return mockResponse({
          status: 200,
          body: JSON.stringify({ success: true, loc: 'home_D.php' }),
          setCookie: 'auth_token=stale; Path=/; HttpOnly',
        });
      }
      if (url.includes('ListNews.php')) {
        return mockResponse({ status: 302, ok: false, body: '' });
      }
      return mockResponse({ status: 404 });
    };

    await expect(scrapeAwazleon('u', 'p')).rejects.toThrow(/awazleon login failed.*redirect/);
  });

  it('throws when auth_token cookie is missing from login response', async () => {
    fetchHandler = (url) => {
      if (url.includes('login_D.php')) {
        return mockResponse({
          status: 200,
          body: JSON.stringify({ success: true, loc: 'home_D.php' }),
          setCookie: null,
        });
      }
      return mockResponse({ status: 404 });
    };

    await expect(scrapeAwazleon('u', 'p')).rejects.toThrow(/awazleon login failed.*Set-Cookie/);
  });

  it('throws when ListNews returns the login form HTML (auth bypassed silently)', async () => {
    const loginPageHtml = `<form id="loginForm"><input name="email"><input name="password"></form>`;
    fetchHandler = (url) => {
      if (url.includes('login_D.php')) {
        return mockResponse({
          status: 200,
          body: JSON.stringify({ success: true }),
          setCookie: 'auth_token=tok; Path=/',
        });
      }
      if (url.includes('ListNews.php')) {
        return mockResponse({ status: 200, body: loginPageHtml });
      }
      return mockResponse({ status: 404 });
    };

    await expect(scrapeAwazleon('u', 'p')).rejects.toThrow(/awazleon login failed.*login page/);
  });
});

// ─── Parser shapes ────────────────────────────────────────────────────────

describe('parseListNewsHtml', () => {
  it('parses card-style article blocks', () => {
    const html = `
      <article class="card">
        <a href="/news/A">Alpha headline</a>
        <time datetime="2026-04-01">2026-04-01</time>
        <p>Alpha body content.</p>
      </article>
      <div class="card">
        <a href="https://awazleon.space/news/B">Beta headline</a>
        <span>15/03/2026</span>
        <p>Beta body content.</p>
      </div>
    `;

    const items = parseListNewsHtml(html);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: 'https://awazleon.space/news/A',
      title: 'Alpha headline',
      publishedAt: '2026-04-01',
    });
    expect(items[0]!.body).toContain('Alpha body content.');
    expect(items[1]).toMatchObject({
      url: 'https://awazleon.space/news/B',
      title: 'Beta headline',
      publishedAt: '2026-03-15',
    });
  });

  it('falls back to <tr> rows when no article/card blocks present', () => {
    const html = `
      <table><tbody>
        <tr><td>2026-02-10</td><td><a href="/n/1">Row title</a></td><td>Row body</td></tr>
        <tr><td>2026-02-09</td><td><a href="/n/2">Second</a></td><td>Second body</td></tr>
      </tbody></table>
    `;

    const items = parseListNewsHtml(html);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: 'https://awazleon.space/n/1',
      title: 'Row title',
      publishedAt: '2026-02-10',
    });
    expect(items[0]!.body).toContain('Row body');
  });

  it('returns null publishedAt when no parseable date', () => {
    const html = `<article class="card"><a href="/x">Title</a><p>No date here.</p></article>`;
    const items = parseListNewsHtml(html);
    expect(items[0]?.publishedAt).toBeNull();
  });

  it('dedupes items sharing a URL', () => {
    const html = `
      <article class="card"><a href="/dup">First</a><p>One</p></article>
      <article class="card"><a href="/dup">Second</a><p>Two</p></article>
    `;
    const items = parseListNewsHtml(html);
    expect(items).toHaveLength(1);
  });

  it('returns [] when no parseable structure is present', () => {
    expect(parseListNewsHtml('<html><body>nothing</body></html>')).toEqual([]);
  });
});
