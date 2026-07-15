// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Feed fetch + parse (RSS 2.0 / RSS 1.0 / Atom).
 *
 * Like the sitemap loader (`../sitemap.ts`), we fetch the XML with native
 * `fetch` rather than going through Crawlee / got-scraping — the same HTTP/2
 * `:authority` bug that breaks `got` on CDN-fronted .se hosts would break
 * feed fetching too. We hand the raw bytes to `rss-parser`, which is pure XML
 * work and behaves correctly. Conditional-GET headers (`If-None-Match` /
 * `If-Modified-Since`) are sent when the caller supplies cache hints, so an
 * unchanged feed answers 304 and we skip re-parsing.
 */
import Parser from "rss-parser";
import { noopLogger } from "../logger";
import { buildUserAgent, DEFAULT_USER_AGENT, type CrawlerRuntimeOptions } from "../options";
import type { CacheHint } from "../crawl-runner";
import { extractFeedLink, looksLikeHtml } from "./discover";
import type { FeedItem, ParsedFeed } from "./types";

const FETCH_TIMEOUT_MS = 15_000;

// Only `parseString` is used (we fetch the XML ourselves with native fetch),
// so no headers are configured here — the User-Agent rides on `fetchOnce`.
const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });

function resolveUrl(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Normalize a feed date (ISO-8601 or RFC-822) to ISO-8601 so it sorts and
 * range-filters correctly downstream. Returns the original string when it
 * isn't parseable (keep something rather than drop it), or null when absent.
 */
function toIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw : new Date(ms).toISOString();
}

function coerceCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c === "string") {
      const t = c.trim();
      if (t) out.push(t);
    } else if (c && typeof c === "object" && "_" in c && typeof c._ === "string") {
      // rss-parser surfaces `<category domain="...">label</category>` as { _, $ }.
      const t = c._.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

type FetchResult = {
  status: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  body: string;
};

async function fetchOnce(
  url: string,
  userAgent: string,
  cacheHint?: CacheHint,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const headers: Record<string, string> = { "User-Agent": userAgent };
  if (cacheHint?.etag) headers["If-None-Match"] = cacheHint.etag;
  if (cacheHint?.lastModified) headers["If-Modified-Since"] = cacheHint.lastModified;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }

  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    body: res.status === 304 ? "" : await res.text(),
  };
}

/**
 * Fetch a feed URL and normalize its items. `cacheHint` enables conditional
 * GET; a 304 response returns `{ notModified: true, items: [] }`. When the URL
 * is a normal HTML page (not a feed), we follow its
 * `<link rel="alternate" type="application/rss+xml">` autodiscovery once and
 * parse the discovered feed — so a source can point at e.g. an org's root URL.
 * `resolvedUrl` reports the URL actually parsed. Network / HTTP / parse / "no
 * feed found" failures throw — the caller lets the run fail so the operator
 * sees the error on the source.
 */
export async function fetchAndParseFeed(
  feedUrl: string,
  cacheHint?: CacheHint,
  options?: CrawlerRuntimeOptions,
): Promise<ParsedFeed> {
  const logger = options?.logger ?? noopLogger;
  const userAgent = buildUserAgent(options?.userAgent ?? DEFAULT_USER_AGENT, "feed-loader");
  const first = await fetchOnce(feedUrl, userAgent, cacheHint);

  if (first.status === 304) {
    return {
      feedTitle: null,
      items: [],
      etag: first.etag,
      lastModified: first.lastModified,
      notModified: true,
      resolvedUrl: feedUrl,
    };
  }
  if (first.status < 200 || first.status >= 300) {
    throw new Error(`feed fetch failed: HTTP ${first.status} for ${feedUrl}`);
  }

  let resolvedUrl = feedUrl;
  let xml = first.body;
  let etag = first.etag;
  let lastModified = first.lastModified;

  // The URL is a page, not a feed → follow autodiscovery one hop.
  if (looksLikeHtml(first.contentType, first.body)) {
    const discovered = extractFeedLink(first.body, feedUrl);
    if (!discovered) {
      throw new Error(`no RSS/Atom feed found at ${feedUrl}`);
    }
    const second = await fetchOnce(discovered, userAgent);
    if (second.status < 200 || second.status >= 300) {
      throw new Error(`feed fetch failed: HTTP ${second.status} for ${discovered}`);
    }
    resolvedUrl = discovered;
    xml = second.body;
    etag = second.etag;
    lastModified = second.lastModified;
  }

  const parsed = await parser.parseString(xml);

  const items: FeedItem[] = [];
  for (const it of parsed.items ?? []) {
    const link = resolveUrl(it.link, resolvedUrl);
    // rss-parser exposes `guid` (RSS) and `id` (Atom). Either is the stable
    // dedup key; fall back to the link when the feed omits both.
    const id =
      (typeof it.guid === "string" && it.guid.trim()) ||
      (typeof (it as { id?: unknown }).id === "string" &&
        ((it as { id: string }).id.trim() || "")) ||
      link;
    if (!id) {
      logger.warn({ feedUrl, title: it.title }, "feed item missing id and link; skipping");
      continue;
    }

    // `contentSnippet` is rss-parser's plain-text rendering; prefer it over the
    // raw HTML `content`. `summary` covers Atom feeds with no content body.
    const summary = (
      it.contentSnippet ||
      (it as { summary?: string }).summary ||
      it.content ||
      ""
    ).trim();

    items.push({
      id,
      title: it.title?.trim() ?? null,
      link,
      summary,
      published: toIso(it.isoDate ?? it.pubDate),
      updated: toIso((it as { updated?: string }).updated),
      author: it.creator ?? (it as { author?: string }).author ?? null,
      categories: coerceCategories(it.categories),
    });
  }

  return {
    feedTitle: parsed.title?.trim() ?? null,
    items,
    etag,
    lastModified,
    notModified: false,
    resolvedUrl,
  };
}

/**
 * Lightweight probe for the add-source dialog: resolve a URL to its feed
 * (following autodiscovery) and report the feed title + item count, or null
 * when nothing resolves. Never throws.
 */
export async function probeFeed(url: string): Promise<{
  feedUrl: string;
  title: string | null;
  itemCount: number;
  discovered: boolean;
} | null> {
  try {
    const parsed = await fetchAndParseFeed(url);
    if (parsed.notModified) return null;
    return {
      feedUrl: parsed.resolvedUrl,
      title: parsed.feedTitle,
      itemCount: parsed.items.length,
      discovered: parsed.resolvedUrl !== url,
    };
  } catch {
    return null;
  }
}
