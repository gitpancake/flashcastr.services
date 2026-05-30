/**
 * Shared Unsplash image helper.
 * Agents import this from @life-os/shared — never call the Unsplash API directly.
 *
 * Requires the UNSPLASH_ACCESS_KEY env var on the calling service.
 * Returns null (never throws) so callers can treat image fetch as best-effort.
 */

interface UnsplashSearchResult {
  results: Array<{
    urls: {
      full: string;
      regular: string;
    };
  }>;
}

export async function fetchUnsplashImage(query: string): Promise<string | null> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    console.warn('[unsplash] UNSPLASH_ACCESS_KEY not set — skipping image fetch');
    return null;
  }

  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${key}` },
    });

    if (!response.ok) {
      console.warn(`[unsplash] API returned ${response.status} for query "${query}"`);
      return null;
    }

    const data = (await response.json()) as UnsplashSearchResult;
    return data.results[0]?.urls?.regular ?? null;
  } catch (err) {
    console.warn('[unsplash] Fetch failed:', (err as Error).message);
    return null;
  }
}
