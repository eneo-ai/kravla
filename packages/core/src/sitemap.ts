// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sitemap discovery + loader.
 *
 * Why this no longer uses Crawlee's `Sitemap.load` / `parseSitemap`
 * over HTTP: those go through `got-scraping` whose HTTP/2 layer rejects
 * responses where the server's `:authority` includes `:443` while the
 * request URL doesn't. Every modern .se CDN-fronted host trips that
 * check, so the old loader silently returned 0 URLs on Sitevision,
 * EpiServer, and basically every site we'd want to crawl. The
 * Crawlee `CheerioCrawler` path already has a workaround
 * (`gotOptions.http2 = false` in `crawl-runner.ts`), but the sitemap
 * utility doesn't expose a hook for it. We fetch the XML ourselves
 * with native `fetch` (no got, no bug) and feed the raw bytes to
 * Crawlee's parser via `{ type: "raw", content }` — that path is
 * pure XML work and behaves correctly.
 *
 * Errors are first-class: every failure is captured into the returned
 * `SitemapLoadResult.errors` so callers can persist a `lastError`
 * record on the source and surface it in the UI. We no longer log
 * sitemap failures at debug and move on — that's how the regression
 * went unnoticed.
 *
 * Sub-sitemap state (per `<sitemap>` entry) is also returned so the
 * indexer can skip refetching unchanged sub-sitemaps on subsequent
 * runs.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseSitemap } from "@crawlee/utils";
import { noopLogger, type Logger } from "./logger";
import { buildUserAgent, DEFAULT_USER_AGENT, type CrawlerRuntimeOptions } from "./options";

const FETCH_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 4_000;
const REACHABILITY_TIMEOUT_MS = 8_000;
// Cap on sub-sitemaps fetched per index. Liferay/Axiell Arena inverts
// the usual "few subs × many URLs" shape — it emits one sub-sitemap per
// layout (≈1 page each), so a single site can list hundreds. Keep this
// generous; truncation past it is logged (see parseOneSitemap).
const MAX_SUB_SITEMAPS = 1000;
// Depth cap for nested `<sitemapindex>` recursion. An index-of-indexes
// (goodreads-style `siteindex.*.xml` shards) is legal per spec; the cap
// guards against cycles and pathological nesting.
const MAX_INDEX_DEPTH = 3;
// Transient-failure retry budget (retries beyond the first attempt) and
// per-retry backoff in ms. Only network errors / timeouts / 5xx / 429 / 202
// are retried — a clean 404 is definitively absent and never retried.
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = [400, 1000];
// Max bytes read when body-sniffing a probe response. Enough to clear any
// XML prolog/BOM and reach the root element.
const PROBE_SNIFF_BYTES = 4096;
// Ceilings for one sitemap document — a crawled host is attacker-controlled
// input, so both the wire read and the gunzip output are hard-bounded
// (a multi-GB decompression bomb would otherwise OOM the crawl worker).
// 50 MB decoded comfortably fits the sitemap-spec limit per file.
const SITEMAP_MAX_FETCH_BYTES = 16 * 1024 * 1024;
const SITEMAP_MAX_XML_BYTES = 50 * 1024 * 1024;
// De-facto sitemap locations, probed (in order) only when robots.txt
// declares none. The list mirrors the strategy validated against 122 real
// hosts. Order matters for `sitemapExists` / `probeSitemapStatus`, which
// sample locations[0] — but every returned candidate is body-sniff verified,
// so any survivor is a real sitemap regardless of position.
const DEFAULT_SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml", // WordPress / Yoast
  "/sitemapindex.xml", // SiteVision — common on Swedish gov/municipal sites
  "/sitemap-index.xml",
  "/sitemap/sitemap.xml",
  "/sitemaps/sitemap.xml",
  "/sitemaps/index.xml",
  "/siteindex.xml",
  "/wp-sitemap.xml", // WordPress 5.5+ core
  "/sitemap.xml.gz",
];

/** One URL entry from a sub-sitemap. */
export type SitemapEntry = {
  url: string;
  lastmod: Date | null;
};

/** Per-sub-sitemap state — persisted on `crawl_source.sitemap_state`. */
export type SitemapSubState = {
  /** lastmod from the `<sitemap><lastmod>` in the parent index, if any. */
  lastmod: string | null;
  urlCount: number;
  /** Hash of the (url, lastmod) tuples in this sub-sitemap. */
  hash: string;
};

export type SitemapLoadError = {
  at: string;
  /** Which URL failed. May be the index URL or a sub-sitemap URL. */
  location: string;
  message: string;
};

export type SitemapLoadResult = {
  /** Concatenated entries across every successfully loaded sub-sitemap. */
  entries: SitemapEntry[];
  /** Hash over all entries — short-circuits "did anything change overall". */
  hash: string;
  /** Per-sub-sitemap state (sub-sitemap URL → state). */
  subStates: Record<string, SitemapSubState>;
  /** Errors during this load (one entry per failed URL). */
  errors: SitemapLoadError[];
  /**
   * Top-level URLs we successfully resolved (the entries from
   * `discoverSitemapLocations`). Useful for diagnostics — when this is
   * empty, the source either has no sitemap or robots.txt + HEAD probes
   * all failed.
   */
  discoveredLocations: string[];
};

/** Outcome of a discovery probe — mirrors the validated four-status taxonomy. */
export type SitemapProbeStatus = "robots" | "path" | "none" | "unreachable";

/** Per-call user-agent + logger, resolved once at each public entry point. */
type SitemapCtx = { ua: string; log: Logger };

function resolveCtx(options?: CrawlerRuntimeOptions): SitemapCtx {
  return {
    ua: buildUserAgent(options?.userAgent ?? DEFAULT_USER_AGENT, "sitemap-loader"),
    log: options?.logger ?? noopLogger,
  };
}

/**
 * Discover sitemap URLs for a seed. Robots.txt first (authoritative —
 * trusted as-is), then body-sniff-probe the de-facto paths in
 * `DEFAULT_SITEMAP_PATHS`. Returns the resolved sitemap URLs (not the page
 * URLs within them). Every probe-path candidate is verified to actually
 * serve XML, so a soft-404 / SPA shell / bot-challenge 200 is never returned.
 */
export async function discoverSitemapLocations(
  seedUrl: string,
  options?: CrawlerRuntimeOptions,
): Promise<string[]> {
  return (await probeSitemapStatus(seedUrl, options)).locations;
}

/**
 * Classify a seed's sitemap availability into the four-status taxonomy and
 * return the resolved locations. Drives the live UI gate: `path`/`robots`
 * mean "offer the sitemap option", `none` means "up but no sitemap"
 * (disable it), `unreachable` means "host down right now" (leave it enabled —
 * a transient failure shouldn't lock the operator out of a real sitemap).
 *
 * robots.txt-declared sitemaps are trusted without sniffing (the only
 * authoritative discovery mechanism per sitemaps.org). Probe-path candidates
 * are body-sniffed. The reachability step only runs when nothing matched.
 */
export async function probeSitemapStatus(
  seedUrl: string,
  options?: CrawlerRuntimeOptions,
): Promise<{ status: SitemapProbeStatus; locations: string[] }> {
  const ctx = resolveCtx(options);
  const seed = new URL(seedUrl);
  const seedOrigin = seed.origin;

  // A seed may point at the sitemap document itself
  // (`https://host/sv/sitemap.xml` — sources created by older Eneo versions
  // are stored that way). When the seed's own path serves sitemap XML it IS
  // the sitemap — trust that explicit pointer over robots.txt and the
  // default-path sweep, which can resolve to a different sitemap than the
  // one the source was saved with.
  // Strict sniff (root `<urlset>`/`<sitemapindex>` required, `<?xml` prolog
  // alone is not enough): an XHTML page must not turn an ordinary
  // path-scoped seed into a site-root sitemap source.
  if (seed.pathname.replace(/\/+$/, "") !== "" && (await probeSitemapXml(seedUrl, ctx, true))) {
    return { status: "path", locations: [seedUrl] };
  }

  const fromRobots = await sitemapsFromRobots(seedOrigin, ctx);
  if (fromRobots.length > 0) return { status: "robots", locations: fromRobots };

  const candidates = DEFAULT_SITEMAP_PATHS.map((p) => `${seedOrigin}${p}`);
  const verified = await Promise.all(candidates.map((c) => probeSitemapXml(c, ctx)));
  const locations = candidates.filter((_, i) => verified[i]);
  if (locations.length > 0) return { status: "path", locations };

  // Nothing found. Distinguish "up, no sitemap" from "host unreachable" so the
  // UI gate doesn't punish a momentarily-down host. Retry transient failures
  // before trusting `unreachable`.
  const reachable = await isReachable(seedOrigin, ctx);
  return { status: reachable ? "none" : "unreachable", locations: [] };
}

/**
 * Fast "does this seed have a usable sitemap?" probe for live UI gating.
 * Thin wrapper over `probeSitemapStatus`: true only when a robots.txt
 * directive or a body-sniff-verified path was found. Returns false for
 * `none` and `unreachable`.
 */
export async function sitemapExists(
  seedUrl: string,
  options?: CrawlerRuntimeOptions,
): Promise<boolean> {
  const { status } = await probeSitemapStatus(seedUrl, options);
  return status === "robots" || status === "path";
}

/**
 * Read `Sitemap:` directives from `/robots.txt` with native `fetch`.
 * Deliberately NOT Crawlee's `RobotsTxtFile.find`: that routes through
 * got-scraping, whose HTTP/2 layer hangs indefinitely on some hosts
 * (e.g. sundsvallsminnen.se) with no timeout — stalling the whole crawl
 * run before a single page is fetched. Same trap the sitemap-fetch path
 * already sidesteps. Returns [] on any failure; the caller then falls
 * back to well-known sitemap paths.
 */
async function sitemapsFromRobots(origin: string, ctx: SitemapCtx): Promise<string[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      signal: ac.signal,
      headers: { "user-agent": ctx.ua, accept: "text/plain,*/*;q=0.5" },
      redirect: "follow",
    });
    if (!res.ok) return [];
    const body = await res.text();
    const out: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m?.[1]) out.push(m[1].trim());
    }
    return out;
  } catch (err) {
    ctx.log.debug({ err: String(err) }, "robots.txt unreachable during sitemap probe");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A status worth retrying: bot-challenge (202), rate-limit (429), or 5xx. */
function isTransientStatus(status: number): boolean {
  return status === 202 || status === 429 || status >= 500;
}

/**
 * `fetch` with bounded per-attempt timeout and sequential retry+backoff on
 * transient failures (network error / abort / 5xx / 429 / 202). A clean 4xx
 * (e.g. 404 = sitemap absent) returns immediately without retrying. Used by
 * the loader and the reachability check — NOT by the fast path-probe, which
 * stays single-shot to keep the debounced UI gate snappy.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ac.signal });
      if (isTransientStatus(res.status) && attempt < RETRY_ATTEMPTS) {
        await delay(RETRY_BACKOFF_MS[attempt] ?? 1000);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        await delay(RETRY_BACKOFF_MS[attempt] ?? 1000);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  // Exhausted retries on transient statuses — surface the last as a throw so
  // callers treat it like any other fetch failure.
  throw lastErr ?? new Error(`exhausted retries for ${url}`);
}

/** Read at most `maxBytes` of a response body, then cancel the stream. */
async function readUpTo(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body;
  if (!body) return Buffer.from(await res.arrayBuffer());
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/**
 * Single-shot probe: does this URL actually serve an XML sitemap? A 200 is
 * not enough — many hosts return an HTML soft-404 / SPA shell for any path.
 * We read the first few KB and require an XML marker. Gzip (`.gz` or
 * `content-encoding: gzip`) can't be partial-decompressed reliably, so we
 * accept on the gzip magic bytes and let `loadSitemap` fully decode+parse it.
 * Rejects 202 (bot-challenge) and any non-2xx. Returns false on any failure.
 *
 * `strict` requires a `<urlset>`/`<sitemapindex>` root marker instead of the
 * default lenient match that also accepts a bare `<?xml` prolog. Used by the
 * seed-self probe, where an XHTML page's prolog would be a false positive;
 * the default-path probes keep the lenient match (those paths are
 * sitemap-only locations, and the prolog can precede a root element that
 * sits beyond the sniff window on exotic emitters).
 */
async function probeSitemapXml(url: string, ctx: SitemapCtx, strict = false): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "user-agent": ctx.ua,
        accept: "application/xml,text/xml,*/*;q=0.5",
        range: `bytes=0-${PROBE_SNIFF_BYTES - 1}`,
      },
      redirect: "follow",
    });
    // 202 is `res.ok` but means bot-challenge, not content — reject it.
    if (!res.ok || res.status === 202) return false;
    const buf = await readUpTo(res, PROBE_SNIFF_BYTES);
    const finalUrl = (res.url || url).toLowerCase();
    const ce = (res.headers.get("content-encoding") ?? "").toLowerCase();
    if (finalUrl.endsWith(".gz") || ce === "gzip") {
      return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    }
    const head = buf.toString("utf8");
    return strict
      ? /<urlset|<sitemapindex/i.test(head)
      : /<\?xml|<urlset|<sitemapindex|<sitemap[\s>]/i.test(head);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the host responding at all? Any HTTP response — even 4xx/5xx — means
 * "up". Only a persistent network failure (after retries) counts as
 * unreachable. Used to separate `none` from `unreachable` in the gate.
 */
async function isReachable(origin: string, ctx: SitemapCtx): Promise<boolean> {
  try {
    await fetchWithRetry(`${origin}/`, {
      method: "GET",
      headers: { "user-agent": ctx.ua, accept: "*/*" },
      redirect: "follow",
      timeoutMs: REACHABILITY_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a sitemap (or any XML) over HTTP, transparently handling gzip
 * for `.xml.gz` URLs and `content-encoding: gzip` responses. Returns
 * the decoded XML string + the response URL after redirects. Throws on
 * any failure — caller wraps into `SitemapLoadError`.
 */
async function fetchSitemapBytes(
  url: string,
  ctx: SitemapCtx,
): Promise<{ xml: string; finalUrl: string }> {
  const res = await fetchWithRetry(url, {
    headers: { "user-agent": ctx.ua, accept: "application/xml,text/xml,*/*;q=0.5" },
    redirect: "follow",
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const finalUrl = res.url || url;
  const buf = await readUpTo(res, SITEMAP_MAX_FETCH_BYTES);
  // Gzip if the URL says so OR the response is encoded that way. Some
  // CDNs strip `content-encoding` after transparent decode and serve
  // the gzipped body anyway; the `.gz` suffix is the signal.
  const ce = (res.headers.get("content-encoding") ?? "").toLowerCase();
  const looksGzipped = finalUrl.toLowerCase().endsWith(".gz") || ce === "gzip";
  if (looksGzipped) {
    try {
      // maxOutputLength makes zlib throw (ERR_BUFFER_TOO_LARGE) instead of
      // expanding a decompression bomb into worker memory.
      return {
        xml: gunzipSync(buf, { maxOutputLength: SITEMAP_MAX_XML_BYTES }).toString("utf8"),
        finalUrl,
      };
    } catch (err) {
      if (
        err instanceof RangeError ||
        (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
      ) {
        throw new Error(`sitemap at ${finalUrl} exceeds ${SITEMAP_MAX_XML_BYTES} bytes decoded`);
      }
      // Not actually gzipped (maybe already decoded by the runtime).
      // Fall through to treating it as plain text.
    }
  }
  return { xml: buf.toString("utf8"), finalUrl };
}

/**
 * Parse one sitemap's XML and emit its entries. Routes to the right
 * arm depending on whether the XML is a `<sitemapindex>` (nested
 * sub-sitemaps) or a `<urlset>` (flat list). Caller handles recursion;
 * this function only walks one document.
 */
async function parseOneSitemap(
  url: string,
  xml: string,
  log: Logger,
): Promise<
  | { kind: "urlset"; entries: SitemapEntry[] }
  | { kind: "index"; subs: { loc: string; lastmod: string | null }[] }
> {
  const isIndex = /<sitemapindex\b/i.test(xml);
  if (isIndex) {
    // `parseSitemap` returns urls from any wrapped sitemap including
    // nested indices, BUT it doesn't expose the parent `<sitemap><lastmod>`
    // — we need that for the sub-sitemap-level skip. Walk the index
    // manually instead.
    const subs: { loc: string; lastmod: string | null }[] = [];
    let truncated = false;
    for (const m of xml.matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/gi)) {
      if (subs.length >= MAX_SUB_SITEMAPS) {
        truncated = true;
        break;
      }
      const block = m[0];
      const rawLoc = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
      if (!rawLoc) continue;
      const loc = decodeXmlEntities(rawLoc);
      const lm = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1] ?? null;
      subs.push({ loc, lastmod: lm });
    }
    if (truncated) {
      log.warn(
        { url, kept: subs.length, cap: MAX_SUB_SITEMAPS },
        "sitemap index exceeds MAX_SUB_SITEMAPS — remaining sub-sitemaps ignored",
      );
    }
    return { kind: "index", subs };
  }

  // Plain urlset — let Crawlee handle the XML parsing.
  const entries: SitemapEntry[] = [];
  try {
    for await (const item of parseSitemap([{ type: "raw", content: xml }])) {
      entries.push({ url: item.loc, lastmod: item.lastmod ?? null });
    }
  } catch (err) {
    // Fall back to a regex pass — the urlset is well-formed enough for
    // our needs even if Crawlee's parser stumbled on namespace quirks.
    for (const m of xml.matchAll(/<url\b[\s\S]*?<\/url>/gi)) {
      const block = m[0];
      const rawLoc = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1];
      if (!rawLoc) continue;
      const loc = decodeXmlEntities(rawLoc);
      const lmStr = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1] ?? null;
      const lm = lmStr ? safeDate(lmStr) : null;
      entries.push({ url: loc, lastmod: lm });
    }
    log.warn(
      { url, err: err instanceof Error ? err.message : String(err), recovered: entries.length },
      "parseSitemap failed on raw content; used regex fallback",
    );
  }
  return { kind: "urlset", entries };
}

function safeDate(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Decode XML entities in text we extract with regex rather than a real
 * parser. `<loc>` values in the wild are entity-encoded — Liferay/Axiell
 * Arena sitemap-index URLs carry query strings as
 * `?p_l_id=74&amp;layoutUuid=…`. Without decoding, the literal `&amp;`
 * survives into the fetch URL, the server drops the mangled params, and
 * an Arena layout-index re-serves its root index → a spurious "nested
 * sitemap index". (The flat-urlset path is immune because it routes
 * through Crawlee's `parseSitemap`, which decodes for us.)
 *
 * Single replace pass so we never double-decode (`&amp;lt;`, the encoded
 * text "&lt;", must stay "&lt;", not collapse to "<"). Unknown or
 * out-of-range entities are left verbatim.
 */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return match;
    }
  });
}

/**
 * Rewrite a sitemap entry URL onto the seed's hostname when the two differ
 * only by a leading `www.`. Drupal/WordPress sites are frequently configured
 * with the apex as the sitemap base URL while the web server redirects apex
 * → www (ai.se does exactly this): every `<loc>` then sits on a host that
 * `isInSeedScope`'s hostname-equality check rejects, and the crawl silently
 * produces zero pages. Rewriting the entries — rather than relaxing the
 * scope check — keeps enqueued URLs, stored page URLs (post-redirect), and
 * the per-URL lastmod skip aligned on one host, and saves a redirect per
 * fetch. Real subdomains are left untouched: only an exact `www.` twin of
 * the seed hostname is rewritten.
 */
export function alignEntryHostWithSeed(entryUrl: string, seedHostname: string): string {
  let u: URL;
  try {
    u = new URL(entryUrl);
  } catch {
    return entryUrl;
  }
  const host = u.hostname;
  if (host === seedHostname) return entryUrl;
  if (host === `www.${seedHostname}` || `www.${host}` === seedHostname) {
    u.hostname = seedHostname;
    return u.toString();
  }
  return entryUrl;
}

function hashEntries(entries: SitemapEntry[]): string {
  const lines = entries.map((e) => `${e.url}\t${e.lastmod?.toISOString() ?? ""}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Load all sitemap entries for a seed, with per-sub-sitemap state and
 * structured errors. Replaces both the old `loadSitemapUrls` (plain
 * URL list) and `loadSitemapData` (URL + lastmod + index hash) — those
 * are gone in the same change so callers must move over.
 */
export async function loadSitemap(
  seedUrl: string,
  options?: CrawlerRuntimeOptions,
): Promise<SitemapLoadResult> {
  const ctx = resolveCtx(options);
  const locations = await discoverSitemapLocations(seedUrl, options);
  let seedHostname: string | null = null;
  try {
    seedHostname = new URL(seedUrl).hostname;
  } catch {
    // Unparseable seed — entries are returned exactly as declared.
  }
  const allEntries: SitemapEntry[] = [];
  const subStates: Record<string, SitemapSubState> = {};
  const errors: SitemapLoadError[] = [];

  const visited = new Set<string>();

  /**
   * Fetch + parse one sitemap document. A `<urlset>` records its entries and
   * sub-state (keyed by its own URL, lastmod inherited from the parent index
   * entry). A `<sitemapindex>` recurses into each sub up to `MAX_INDEX_DEPTH`
   * — covering an index-of-indexes — past which the nesting is recorded as an
   * error so the operator notices rather than silently truncating.
   */
  async function processOne(
    url: string,
    depth: number,
    parentLastmod: string | null,
  ): Promise<void> {
    if (visited.has(url)) return;
    visited.add(url);

    let fetched: { xml: string; finalUrl: string };
    try {
      fetched = await fetchSitemapBytes(url, ctx);
    } catch (err) {
      errors.push({
        at: new Date().toISOString(),
        location: url,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Dedupe by post-redirect URL. `/sitemap.xml` commonly 301s to
    // `/wp-sitemap.xml`, so both can surface as discovered candidates and
    // resolve to the same document — process it only once.
    if (fetched.finalUrl !== url) {
      if (visited.has(fetched.finalUrl)) return;
      visited.add(fetched.finalUrl);
    }

    let parsed: Awaited<ReturnType<typeof parseOneSitemap>>;
    try {
      parsed = await parseOneSitemap(url, fetched.xml, ctx.log);
    } catch (err) {
      errors.push({
        at: new Date().toISOString(),
        location: url,
        message: `parse failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (parsed.kind === "urlset") {
      // Align www-twin hosts before anything downstream sees the entries, so
      // the sub-state hash, the whole-index hash, and the scope filter all
      // operate on the same URLs the crawler will enqueue.
      const entries = seedHostname
        ? parsed.entries.map((e) => {
            const aligned = alignEntryHostWithSeed(e.url, seedHostname);
            return aligned === e.url ? e : { ...e, url: aligned };
          })
        : parsed.entries;
      allEntries.push(...entries);
      subStates[url] = {
        // lastmod from the parent `<sitemap><lastmod>`, if any. A top-level
        // urlset has none → null, and sub-sitemap skipping is a no-op there.
        lastmod: parentLastmod,
        urlCount: entries.length,
        hash: hashEntries(entries),
      };
      return;
    }

    // Index — recurse into each sub, depth-capped.
    if (depth >= MAX_INDEX_DEPTH) {
      errors.push({
        at: new Date().toISOString(),
        location: url,
        message: `sitemap index nesting exceeds MAX_INDEX_DEPTH (${MAX_INDEX_DEPTH})`,
      });
      return;
    }
    for (const sub of parsed.subs) {
      await processOne(sub.loc, depth + 1, sub.lastmod);
    }
  }

  for (const loc of locations) await processOne(loc, 0, null);

  const hash = hashEntries(allEntries);
  return {
    entries: allEntries,
    hash,
    subStates,
    errors,
    discoveredLocations: locations,
  };
}
