// SPDX-License-Identifier: MIT
/**
 * Thin wrapper around Crawlee `CheerioCrawler` for Phase 1.
 *
 * - HTTP only (no headless browser).
 * - Respects robots.txt via a native-fetch preflight/filter.
 * - Same-hostname depth-limited link enqueuing.
 * - Optional HTTP basic-auth via a pre-navigation hook.
 * - Optional conditional-GET via `cacheHints` — when supplied, each request
 *   carries `If-None-Match` / `If-Modified-Since` from a prior response.
 *   A 304 reply lands the URL in `unchanged` instead of `ok`, saving the
 *   parse/chunk/embed pipeline downstream.
 * - Crawlee's persistent storage is disabled per call (we don't need
 *   resumable runs at this stage; the BullMQ retry config covers job-level
 *   resumption).
 *
 * Returns three outcome buckets:
 *   - `ok`        — fetched, parsed, content returned. Includes any
 *                   `etag`/`lastModified` from the response so the caller
 *                   can persist them for the next refresh.
 *   - `unchanged` — server replied 304. Caller should bump `fetched_at` only.
 *   - `failed`    — terminal failure (AFTER retries exhausted).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Direct @crawlee/* subpackage imports — see preview.ts for the reason.
import { CheerioCrawler } from "@crawlee/cheerio";
import { Configuration } from "@crawlee/core";
import { isInSeedScope, pathPrefixGlobs, sitemapSeedScopeUrl } from "./scope";
import { normalizeCrawlUrl, resolvePageIdentityUrl } from "./page-identity-url";
import { extractContent } from "./extract";
import { runEnrichers } from "./enrichers";
import { runDetectors, type DetectorMatch } from "./detectors";
import { extractFileLinks, FILE_EXCLUDE_GLOBS, isNonHtmlUrl, type FileLink } from "./file-links";
import {
  loadRobotsPolicyForUrl,
  effectiveMaxRequestsPerMinute,
  buildRobotsSnapshot,
  type RobotsSnapshot,
} from "./robots";
import { isExcludedCrawlUrl } from "./url-exclusions";
import { resolvePageDates, type PageDateSources } from "./page-dates";
import { noopLogger, type Logger } from "./logger";

// Defaults for the four runtime knobs. Callers override per run.
const DEFAULT_PAGE_CONCURRENCY = 1;
// Cadence of the info-level "crawl progress" log. Rate-limited crawls are
// otherwise silent between Crawlee's 60 s statistics blocks.
const PROGRESS_LOG_EVERY_PAGES = 5;
const DEFAULT_MEMORY_MBYTES = 1024;
const DEFAULT_REQUEST_HANDLER_TIMEOUT_SECS = 15 * 60;
const DEFAULT_MAX_HTML_BYTES = 8 * 1024 * 1024;

export type CrawlPage = {
  url: string;
  title: string | null;
  rawText: string;
  /** Response `ETag` header, if any. Persisted for the next refresh's `If-None-Match`. */
  etag: string | null;
  /**
   * Response `Last-Modified` header, if any. Persisted verbatim for
   * `If-Modified-Since` — a cache hint, NOT a content date. The normalized
   * content-modification date lives in `modifiedAt`.
   */
  lastModified: string | null;
  /**
   * Normalized publish/creation date (full ISO 8601 UTC) resolved from the
   * page's own date signals (JSON-LD, `article:*` meta, dcterms, `<time>`),
   * or null when the page carries none. See `resolvePageDates`.
   */
  publishedAt: string | null;
  /**
   * Normalized content-modification date (full ISO 8601 UTC) from the same
   * cascade plus the sitemap's per-URL `<lastmod>`. The HTTP `Last-Modified`
   * header never feeds this — on CMS pages it is template render time.
   */
  modifiedAt: string | null;
  /** Which signal each resolved date came from. Null when both dates are null. */
  dateSources: PageDateSources | null;
  /** When this page was fetched by the crawler (ISO 8601 UTC). Always set. */
  fetchedAt: string;
  fileLinks: FileLink[];
  /**
   * Specialised crawlers (Open ePlatform, etc.) attach a structured record
   * describing the page in domain terms. Generic Crawlee crawls leave this
   * undefined → `source_document.metadata` is stored without crawler-specific
   * fields. The shape is opaque here — readers should narrow on
   * `metadata.provider` before reading further.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * Additional short strings the indexer should embed alongside `rawText` as
   * separate chunks. Used by specialised crawlers that want per-field views
   * (e.g., one chunk for `<category>: <name>`, one for `<name> – <description>`)
   * to improve recall on short queries. Each entry becomes one extra
   * `chunk` row after `splitText` (typically 1 chunk each since the strings
   * are short).
   */
  extraChunks?: string[];
  /**
   * Platform-detection results for this page from `runDetectors`. Each
   * match represents a third-party platform we recognised in the markup
   * (Sitevision, Open ePlatform, Infracontrol, …). The indexer stores
   * these in `source_document.metadata.detectedPlatforms` so later rollups
   * can work without re-fetching.
   * Specialised crawlers leave this undefined; the generic Crawlee path
   * populates it from the requestHandler hook.
   */
  detectedPlatforms?: DetectorMatch[];
};

/**
 * Per-URL "server said unchanged" outcome. The body was never downloaded;
 * the caller just bumps `source_document.fetched_at` and skips re-chunking/embedding.
 */
export type UnchangedUrl = {
  url: string;
};

/**
 * Per-URL failure surfaced from Crawlee's `failedRequestHandler` — fires
 * AFTER retries are exhausted. Classified into a small enum so the UI can
 * render badge variants + the operator can filter "show only timeouts".
 */
export type FailedUrl = {
  url: string;
  status: "http_error" | "timeout" | "fetch_error";
  httpStatus?: number;
  errorMessage: string;
};

export type SkippedRobotsUrl = {
  url: string;
};

export type CrawlOutcome = {
  okCount: number;
  unchangedCount: number;
  failedCount: number;
  skippedCount: number;
  skippedRobotsCount?: number;
  robotsBlockedSeed?: boolean;
  /**
   * URLs we declined to ingest because the response Content-Type didn't
   * match what the URL implied. Today: HTML-positioned URLs that served
   * non-HTML (Sitevision's `/download/{id}` no-extension paths, `.srt`
   * files in a sitemap, etc.). Reserved for the symmetric case too —
   * a `<a href="thing.pdf">` that returns a soft-404 HTML page belongs
   * here, not in `failedCount`. Discovered at fetch time; not factored
   * into `termination_reason`.
   */
  skippedByContentType: number;
  /**
   * Discovered links that returned a deterministic client error
   * (`NON_RETRYABLE_STATUSES`: 401/403 auth-gated, 404/410 gone). These are not
   * crawl failures — an outbound link to a login-gated e-service or a dead page
   * is an expected outcome — so they are recorded per-URL as `skipped_unavailable`
   * and kept out of `failedCount`. Optional: `open_eplatform` outcomes omit it.
   */
  skippedUnavailableCount?: number;
  /**
   * Snapshot of the robots.txt evaluation for this run, persisted to
   * `crawl_source.robots_state`. Null for `open_eplatform` (no robots fetch)
   * and undefined when the run aborted before robots was loaded.
   */
  robots?: RobotsSnapshot | null;
};

export type CacheHint = {
  etag: string | null;
  lastModified: string | null;
};

/** One sitemap-mode URL: bare, or with the sitemap entry's `<lastmod>` as an ISO string. */
export type SitemapUrlInput = string | { url: string; lastmod?: string | null };

export type CrawlRunnerInput = {
  seedUrl: string;
  // `open_eplatform` sources reach the dispatcher through this input shape
  // too; they take the streaming adapter in `./open-eplatform/streaming.ts`,
  // not the Crawlee runner below. The two branches inside `runCrawl` that
  // gate on `=== "crawl"` / `=== "sitemap"` leave `open_eplatform` as a no-op.
  crawlType: "crawl" | "sitemap" | "open_eplatform" | "feed";
  depth: number;
  crawlScope?: "depth_limited" | "path_prefix";
  httpAuth?: { user: string; password: string } | null;
  maxRequestsPerCrawl?: number;
  maxRequestsPerMinute?: number;
  /**
   * Minimum gap between two requests to the same host, in seconds. Maps to
   * Crawlee's `sameDomainDelaySecs`. A robots.txt `Crawl-delay` is folded in —
   * the effective gap is the larger of the two.
   */
  requestDelaySeconds?: number;
  excludeUrlPatterns?: string[];
  /**
   * Whether the source indexes linked documents. The Crawlee runner does not
   * read this (linked-file enqueue is gated downstream in `processCrawlRun`);
   * the feed runner uses it to decide whether to fetch + inline an entry's
   * linked HTML article into the entry's text.
   */
  indexLinkedFiles?: boolean;
  /**
   * Also report linked tabular files (csv/xlsx) in `fileLinks`. Default
   * false so existing consumers see no new link kinds without opting in —
   * what the consumer does with them (ingest as datasets, count, ignore) is
   * its own decision.
   */
  includeTabularFileLinks?: boolean;
  /**
   * Display name attached to harvested e-services (`open_eplatform` only;
   * other crawl types ignore it). The crawler has no municipality registry —
   * the caller derives the name from the seed URL however it likes.
   */
  municipalityName?: string | null;
  /**
   * Conditional-GET hints keyed by URL. When set, the preNavigationHook
   * sends `If-None-Match` / `If-Modified-Since` for matching URLs. Caller
   * passes `undefined` (or an empty map) to skip cache hints entirely
   * (e.g. for a manual `force: true` run).
   */
  cacheHints?: Map<string, CacheHint>;
  /**
   * Pre-resolved URLs for sitemap mode. Bypasses sitemap fetch when provided.
   * Entries may carry the sitemap's per-URL `<lastmod>` (ISO string) — it is
   * threaded through request userData into the page's `modifiedAt` cascade.
   * Plain strings keep working for callers without lastmod data.
   */
  sitemapUrls?: SitemapUrlInput[];
  /**
   * Sitemap locations the URLs were loaded from
   * (`SitemapLoadResult.discoveredLocations`). Lets the runner recognize a
   * seed that points at the sitemap document itself and strip the sitemap
   * part, widening scope filtering to the site root.
   */
  sitemapDiscoveredLocations?: string[];
  /** URLs already processed in a prior attempt. Skipped to avoid re-embedding. */
  skipUrls?: Set<string>;
  onPage?: (page: CrawlPage) => Promise<void>;
  onUnchanged?: (url: UnchangedUrl) => Promise<void>;
  onFailed?: (failure: FailedUrl) => Promise<void>;
  /**
   * Called for a discovered link that returned a deterministic client error
   * (`NON_RETRYABLE_STATUSES`). Recorded as `skipped_unavailable`, not a failure.
   */
  onSkippedUnavailable?: (skipped: { url: string; httpStatus: number }) => Promise<void>;
  onSkippedRobots?: (skipped: SkippedRobotsUrl) => Promise<void>;
  /** Called immediately after robots.txt is loaded, before page crawling starts. */
  onRobotsLoaded?: (robots: RobotsSnapshot) => Promise<void>;
  signal?: AbortSignal;
  /** Structural pino-compatible logger; silent when omitted. */
  logger?: Logger;
  /**
   * Product token for robots.txt rule matching and User-Agent headers.
   * Default `"kravla"` (see `DEFAULT_USER_AGENT` in `./options`).
   */
  userAgent?: string;
  /** Concurrent page fetches inside this crawl. Default 1 (polite). */
  pageConcurrency?: number;
  /** Crawlee autoscaled-pool memory budget (MB) — not a container limit. Default 1024. */
  memoryMbytes?: number;
  /** Wall-clock cap for one request handler, in seconds. Default 900. */
  requestHandlerTimeoutSecs?: number;
  /** Max HTML body bytes accepted for extraction; 0 disables the guard. Default 8 MiB. */
  maxHtmlBytes?: number;
};

// Crawlee throws this from `_abortDownloadOfBody` when the response
// Content-Type isn't one of the accepted MIME types. The phrasing has
// been stable across v3.x — anchor the match on the two unique words
// "served" and "Content-Type" together rather than a longer fragment.
const NON_HTML_MIME_ERROR = /served Content-Type .* (?:but only|is not)/i;
const DOCUMENT_MIME_TYPES = new Set([
  "text/html",
  "text/xml",
  "application/xhtml+xml",
  "application/xml",
  "application/json",
]);

// Statuses where the server is explicitly asking us to slow down. On these we
// honor `Retry-After` before Crawlee's retry instead of hammering through the
// remaining `maxRequestRetries` back-to-back.
const RATE_LIMIT_STATUSES = new Set([429, 503]);

// Deterministic client errors that won't change on retry — fail fast instead of
// burning all `maxRequestRetries`. 401/403 (auth-gated, e.g. e-tjänst overview
// pages) and 404/410 (gone) return the identical response every time, so the
// retries only add load and delay the `failedRequestHandler` classification.
const NON_RETRYABLE_STATUSES = new Set([401, 403, 404, 410]);
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 10_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 120_000;

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or null. */
function parseRetryAfterMs(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function classifyError(
  error: unknown,
  httpStatus: number | undefined,
): { status: FailedUrl["status"]; httpStatus?: number } {
  if (httpStatus !== undefined && httpStatus >= 400) {
    return { status: "http_error", httpStatus };
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || /timeout/i.test(message)) return { status: "timeout" };
  return { status: "fetch_error" };
}

function inferResponseMimeType(url: string, contentTypeHeader: string | undefined): string {
  const headerMimeType = contentTypeHeader?.split(";")[0]?.trim().toLowerCase();
  if (headerMimeType) return headerMimeType;

  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }

  if (pathname.endsWith(".html") || pathname.endsWith(".htm")) return "text/html";
  if (pathname.endsWith(".xml")) return "application/xml";
  if (pathname.endsWith(".xhtml")) return "application/xhtml+xml";
  if (pathname.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export async function runCrawl(input: CrawlRunnerInput): Promise<CrawlOutcome> {
  if (input.signal?.aborted) {
    return {
      okCount: 0,
      unchangedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      skippedRobotsCount: 0,
      robotsBlockedSeed: false,
      skippedByContentType: 0,
    };
  }

  let okCount = 0;
  let unchangedCount = 0;
  let failedCount = 0;
  let skippedUnavailable = 0;
  let skippedByContentType = 0;
  let skippedCount = 0;
  let skippedRobotsCount = 0;
  const skippedRobotsUrls = new Set<string>();
  const notifiedSkippedRobotsUrls = new Set<string>();
  const skipUrls = input.skipUrls;
  const logger = input.logger ?? noopLogger;
  const log = logger.child({ component: "crawl-runner" });
  const maxHtmlBytes = input.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const robots =
    input.crawlType === "crawl" || input.crawlType === "sitemap"
      ? await loadRobotsPolicyForUrl(input.seedUrl, fetch, {
          logger,
          userAgent: input.userAgent,
        })
      : null;
  const robotsSnapshot = robots ? buildRobotsSnapshot(robots, input.seedUrl) : null;
  if (robotsSnapshot) {
    try {
      await input.onRobotsLoaded?.(robotsSnapshot);
    } catch (err) {
      logger.warn({ err }, "failed to persist robots.txt snapshot");
    }
  }

  if (input.crawlType === "crawl" && robots && !robots.allows(input.seedUrl)) {
    noteSkippedRobots(input.seedUrl);
    await notifySkippedRobots(input.seedUrl);
    return {
      okCount: 0,
      unchangedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      skippedRobotsCount,
      robotsBlockedSeed: true,
      skippedByContentType: 0,
      robots: robotsSnapshot,
    };
  }

  // Isolated per-call storage so concurrent runs (or test re-runs) don't
  // share Crawlee's request-queue/dataset state.
  const storageDir = mkdtempSync(join(tmpdir(), "crawlee-"));
  const crawleeConfig = new Configuration({
    persistStorage: false,
    storageClientOptions: { localDataDirectory: storageDir },
    memoryMbytes: input.memoryMbytes ?? DEFAULT_MEMORY_MBYTES,
  });

  const basicAuthHeader = input.httpAuth
    ? "Basic " + Buffer.from(`${input.httpAuth.user}:${input.httpAuth.password}`).toString("base64")
    : null;

  const cacheHints = input.cacheHints;
  const crawlFullPath = input.crawlType === "crawl" && input.crawlScope === "path_prefix";

  // Seed used to scope-check a page's `rel=canonical` before honoring it. A
  // sitemap seed that names the sitemap document widens to the site root,
  // mirroring how sitemap entries themselves are scoped below.
  const scopeSeedUrl =
    input.crawlType === "sitemap"
      ? sitemapSeedScopeUrl(input.seedUrl, input.sitemapDiscoveredLocations)
      : input.seedUrl;

  // Heartbeat between Crawlee's 60 s statistics blocks: one line per
  // PROGRESS_LOG_EVERY_PAGES handled pages (fresh or 304-unchanged).
  let handledPages = 0;
  function noteProgress(url: string): void {
    handledPages += 1;
    if (handledPages % PROGRESS_LOG_EVERY_PAGES !== 0) return;
    log.info(
      {
        pages: okCount,
        unchanged: unchangedCount,
        failed: failedCount,
        skippedRobots: skippedRobotsCount,
        skippedUnavailable,
        skippedNonHtml: skippedByContentType,
        skippedKnown: skippedCount,
        lastUrl: url,
      },
      "crawl progress",
    );
  }

  function noteSkippedRobots(url: string): void {
    if (skippedRobotsUrls.has(url)) return;
    skippedRobotsUrls.add(url);
    skippedRobotsCount += 1;
    log.debug({ url }, "skipping url: disallowed by robots.txt");
  }

  async function notifySkippedRobots(url: string): Promise<void> {
    if (notifiedSkippedRobotsUrls.has(url)) return;
    notifiedSkippedRobotsUrls.add(url);
    await input.onSkippedRobots?.({ url });
  }

  const crawler = new CheerioCrawler(
    {
      maxConcurrency: input.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY,
      maxRequestsPerMinute:
        effectiveMaxRequestsPerMinute(
          input.maxRequestsPerMinute ?? 60,
          robots?.crawlDelaySeconds ?? null,
        ) ?? 60,
      // Hard minimum gap between same-host requests. The robots.txt
      // `Crawl-delay` is enforced as a strict gap here (not just folded into
      // the per-minute average above), taking the larger of it and the
      // operator-configured delay. 0 → Crawlee's default (no gap).
      sameDomainDelaySecs: Math.max(
        input.requestDelaySeconds ?? 0,
        robots?.crawlDelaySeconds && robots.crawlDelaySeconds > 0 ? robots.crawlDelaySeconds : 0,
      ),
      maxRequestRetries: 3,
      requestHandlerTimeoutSecs:
        input.requestHandlerTimeoutSecs ?? DEFAULT_REQUEST_HANDLER_TIMEOUT_SECS,
      navigationTimeoutSecs: 30,
      // Must stay false: Crawlee's robots support calls `RobotsTxtFile.find()`,
      // which fetches robots.txt through got-scraping over HTTP/2 and bypasses
      // our `http2: false` preNavigationHook. On hosts that reject got's HTTP/2
      // (CDN-fronted .se hosts that trip the `:authority` / cipher check — e.g.
      // sundsvallsminnen.se) that fetch hangs with no timeout, and because it
      // runs on the first request it blocks the entire crawl at 0 pages (and
      // churns CPU on got's retries). Same got-scraping trap the sitemap loader
      // avoids with native fetch. If we want to honor robots Disallow rules, do
      // it via a native-fetch robots parse here — not by re-enabling this flag.
      respectRobotsTxtFile: false,
      maxRequestsPerCrawl: input.maxRequestsPerCrawl,
      maxCrawlDepth: input.crawlType === "crawl" && !crawlFullPath ? input.depth : undefined,
      // Treat 304 as success so it reaches the requestHandler (default
      // Got behavior throws on non-2xx). Crawlee passes this through.
      // Crawlee infers bodyless 304 responses as application/octet-stream and
      // aborts before requestHandler. Let them through, then enforce the
      // document MIME allow-list below for non-304 responses.
      additionalMimeTypes: ["application/octet-stream", "text/csv", "application/csv"],
      preNavigationHooks: [
        // Disable HTTP/2 — `got` + `http2-wrapper` has a strict origin-vs-server
        // check that rejects responses where the server's `:authority` includes
        // an explicit `:443` and the request URL didn't (some CDN/origin combos
        // do this, e.g. `oddlyeven.se`). Falling back to HTTP/1.1 sidesteps
        // the bug; perf cost is irrelevant for polite crawls.
        //
        // This got-scraping HTTP/2 trap (`:authority`/cipher rejection on many
        // CDN-fronted .se hosts) reaches Crawlee through THREE independent HTTP
        // entry points, each needing its own opt-out — there is no single global
        // toggle because got-scraping bakes `http2: true` into an immutable
        // instance and robots bypasses the pluggable client:
        //   1. Page fetches    — this hook (or a custom `httpClient`).
        //   2. Robots          — `respectRobotsTxtFile: false` above (Crawlee's
        //                          `RobotsTxtFile.find` hardcodes got-scraping,
        //                          ignores `httpClient`, has no timeout).
        //   3. Sitemap loader  — `loadSitemap` uses native `fetch`, not Crawlee.
        // The only fix that covers all three at once is monkeypatching the shared
        // got-scraping export to `.extend({ http2: false })` at startup —
        // deliberately rejected as too brittle across upstream bumps.
        async (_ctx, gotOptions) => {
          (gotOptions as { http2?: boolean }).http2 = false;
        },
        // Conditional-GET headers — sent only when a hint exists for the URL.
        async ({ request }: { request: { url: string; headers?: Record<string, string> } }) => {
          if (!cacheHints) return;
          const hint = cacheHints.get(request.url);
          if (!hint) return;
          const headers = { ...(request.headers ?? {}) };
          if (hint.etag) headers["If-None-Match"] = hint.etag;
          if (hint.lastModified) headers["If-Modified-Since"] = hint.lastModified;
          request.headers = headers;
        },
        ...(basicAuthHeader
          ? [
              async ({ request }: { request: { headers?: Record<string, string> } }) => {
                request.headers = { ...(request.headers ?? {}), Authorization: basicAuthHeader };
              },
            ]
          : []),
      ],
      async requestHandler({ $, request, response, enqueueLinks, body }) {
        if (input.signal?.aborted) return;

        const url = request.loadedUrl ?? request.url;
        if (robots && !robots.allows(url)) {
          noteSkippedRobots(url);
          await notifySkippedRobots(url);
          return;
        }
        const isSkipped = skipUrls?.has(url) ?? false;
        const currentDepth =
          typeof request.userData.depth === "number" ? request.userData.depth : 0;

        if (response?.statusCode === 304) {
          if (!isSkipped) {
            unchangedCount += 1;
            await input.onUnchanged?.({ url });
            noteProgress(url);
          } else {
            skippedCount += 1;
            log.debug({ url }, "skipping url: listed in skip_urls (already processed)");
          }
          return;
        }

        const responseHeaders = (response?.headers ?? {}) as Record<string, string | undefined>;
        const mimeType = inferResponseMimeType(url, responseHeaders["content-type"]);
        if (!DOCUMENT_MIME_TYPES.has(mimeType)) {
          skippedByContentType += 1;
          log.debug({ url, mimeType }, "skipping url: non-document content-type");
          return;
        }

        // Crawl mode: enqueue outgoing links BEFORE the skip check so
        // already-processed pages still contribute to link discovery.
        if (input.crawlType === "crawl" && (crawlFullPath || currentDepth < input.depth)) {
          await enqueueLinks({
            strategy: "same-hostname",
            globs: pathPrefixGlobs(input.seedUrl),
            exclude: FILE_EXCLUDE_GLOBS,
            transformRequestFunction: (nextRequest) => {
              if (isExcludedCrawlUrl(nextRequest.url, input.excludeUrlPatterns)) return false;
              if (robots && !robots.allows(nextRequest.url)) {
                noteSkippedRobots(nextRequest.url);
                return false;
              }
              if (isNonHtmlUrl(nextRequest.url)) return false;
              // Drop tracking params / fragments so `?utm_*` variants collapse
              // to a single fetch instead of N near-identical pages.
              nextRequest.url = normalizeCrawlUrl(nextRequest.url);
              nextRequest.userData = {
                ...nextRequest.userData,
                depth: currentDepth + 1,
              };
              return nextRequest;
            },
          });
        }

        if (isSkipped) {
          skippedCount += 1;
          log.debug({ url }, "skipping url: listed in skip_urls (already processed)");
          return;
        }

        const html = typeof body === "string" ? body : $.html();
        const htmlBytes = Buffer.byteLength(html);
        if (maxHtmlBytes > 0 && htmlBytes > maxHtmlBytes) {
          const errorMessage = `HTML response body ${htmlBytes} bytes exceeds maxHtmlBytes (${maxHtmlBytes})`;
          failedCount += 1;
          log.warn(
            {
              url,
              htmlBytes,
              maxHtmlBytes,
            },
            "crawl page exceeds max HTML size; skipping indexing",
          );
          await input.onFailed?.({
            url,
            status: "fetch_error",
            errorMessage,
          });
          return;
        }

        const extracted = extractContent(html, url);
        // Enrichers run against the same cheerio Crawlee already loaded —
        // no re-parse, no extra fetch. They pull `<head>` metadata,
        // schema.org JSON-LD, and Sitevision portlets that Readability's
        // main-content pass would otherwise discard.
        const enrichment = runEnrichers({ $, url });
        // Detector pass — same cheerio instance, no extra fetch. Matches are
        // persisted on source-document metadata downstream.
        const detectorHeaders = Object.fromEntries(
          Object.entries(responseHeaders).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
        const detectedPlatforms = runDetectors(
          { $, url, headers: detectorHeaders },
          logger.child({ component: "detectors", url }),
        );
        // Normalized content dates from the enriched metadata + the sitemap
        // entry's <lastmod> (sitemap mode only — crawl-mode requests carry
        // no sitemapLastmod). HTTP Last-Modified deliberately stays out.
        const sitemapLastmod =
          typeof request.userData.sitemapLastmod === "string"
            ? request.userData.sitemapLastmod
            : null;
        const dates = resolvePageDates({
          metadata: enrichment.metadata,
          sitemapLastmod,
        });
        // The raw value of every date signal stays inspectable on metadata —
        // the other sources live in their enricher namespaces already; the
        // sitemap lastmod arrives via userData, so it's attached here.
        const metadata = sitemapLastmod
          ? { ...(enrichment.metadata ?? {}), sitemap: { lastmod: sitemapLastmod } }
          : enrichment.metadata;
        // Store the page under its canonical identity so pagination and
        // print/variant URLs the site declares equivalent collapse onto one
        // row. The fetched `url` still drives extraction, link discovery and
        // file-link resolution above — only the persisted identity changes.
        const identityUrl = resolvePageIdentityUrl({
          fetchedUrl: url,
          canonicalUrl:
            typeof enrichment.metadata?.canonicalUrl === "string"
              ? enrichment.metadata.canonicalUrl
              : null,
          scopeSeedUrl,
        });
        okCount += 1;
        await input.onPage?.({
          url: identityUrl,
          title: extracted.title,
          rawText: extracted.markdown,
          etag: responseHeaders.etag ?? null,
          lastModified: responseHeaders["last-modified"] ?? null,
          publishedAt: dates.publishedAt,
          modifiedAt: dates.modifiedAt,
          dateSources: dates.dateSources,
          fetchedAt: new Date().toISOString(),
          fileLinks: extractFileLinks($, url, input.seedUrl, {
            includeTabular: input.includeTabularFileLinks === true,
          }),
          metadata,
          extraChunks: enrichment.extraChunks.length > 0 ? enrichment.extraChunks : undefined,
          detectedPlatforms: detectedPlatforms.length > 0 ? detectedPlatforms : undefined,
        });
        noteProgress(url);
      },
      // Fires BEFORE each retry (while retries remain). On a 429/503 we honor
      // `Retry-After` and pause before Crawlee re-queues the request, so a
      // rate-limited host isn't hammered through the remaining retries. With
      // `maxConcurrency: 1` this serializes the whole crawl for the backoff.
      async errorHandler({ request, response }, error) {
        if (input.signal?.aborted) return;
        const errResponse = (
          error as { response?: { statusCode?: number; headers?: Record<string, unknown> } }
        )?.response;
        const status = response?.statusCode ?? errResponse?.statusCode;
        // Deterministic client errors won't change on retry — short-circuit the
        // remaining `maxRequestRetries` so the request goes straight to
        // `failedRequestHandler` (where it's recorded as skipped, not failed).
        if (status !== undefined && NON_RETRYABLE_STATUSES.has(status)) {
          request.noRetry = true;
          return;
        }
        if (status === undefined || !RATE_LIMIT_STATUSES.has(status)) return;
        const headers = (response?.headers ?? errResponse?.headers ?? {}) as Record<
          string,
          string | string[] | undefined
        >;
        const waitMs = Math.min(
          parseRetryAfterMs(headers["retry-after"]) ?? DEFAULT_RATE_LIMIT_BACKOFF_MS,
          MAX_RATE_LIMIT_BACKOFF_MS,
        );
        log.info({ url: request.url, status, waitMs }, "rate limited; backing off before retry");
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      },
      // Fires AFTER `maxRequestRetries` is exhausted, so each URL appears
      // at most once. We classify the error into our enum and pass it back
      // to `process-run.ts` for persistence into `crawl_run_page`.
      async failedRequestHandler({ request, response }, error) {
        if (input.signal?.aborted) return;

        const url = request.loadedUrl ?? request.url;
        if (skipUrls?.has(url)) {
          skippedCount += 1;
          log.debug({ url }, "skipping url: listed in skip_urls (already processed)");
          return;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        const httpStatus = response?.statusCode;
        // Deterministic client errors on a discovered link (401/403 auth-gated,
        // 404/410 gone) aren't crawl failures — `errorHandler` already marked
        // them `noRetry`. Record them as skipped, not failed. Checked BEFORE the
        // MIME guard below: a 404/410 often serves a non-HTML body (a `text/plain`
        // "not found"), and the status code is the more meaningful signal than the
        // content-type abort it would otherwise be miscounted as.
        if (httpStatus !== undefined && NON_RETRYABLE_STATUSES.has(httpStatus)) {
          skippedUnavailable += 1;
          log.info({ url, httpStatus }, "skipping url: unavailable (auth-gated or gone)");
          await input.onSkippedUnavailable?.({ url, httpStatus });
          return;
        }
        // Crawlee aborts before requestHandler when the response Content-Type
        // isn't HTML/XML/JSON. The sitemap loader's extension-based filter
        // can't catch these (no extension on the URL, or an unusual one
        // like `.srt`); they're sitemap noise, not coverage failures.
        if (NON_HTML_MIME_ERROR.test(errorMessage)) {
          skippedByContentType += 1;
          log.debug({ url }, "skipping url: non-document content-type");
          return;
        }
        const cls = classifyError(error, httpStatus);
        failedCount += 1;
        await input.onFailed?.({
          url,
          status: cls.status,
          httpStatus: cls.httpStatus,
          errorMessage,
        });
      },
    },
    crawleeConfig,
  );

  const onAbort = () => crawler.autoscaledPool?.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (input.crawlType === "sitemap") {
      // Sitemap mode: caller is expected to pass the already-loaded
      // URL list. `loadSitemap` is the source of truth (lives in the
      // indexer's run-prep stage). We don't fall back to fetching here
      // because failures need to be surfaced to the crawl run, not
      // silently absorbed by the worker.
      const entries = (input.sitemapUrls ?? []).map((e) =>
        typeof e === "string"
          ? { url: e, lastmod: null }
          : { url: e.url, lastmod: e.lastmod ?? null },
      );
      // A seed pointing at the sitemap document itself scopes to the site
      // root (sitemap part stripped) — page URLs never live under the
      // sitemap's own path, so seed-prefix scope would filter out every entry.
      const scopedEntries = entries.filter(
        (e) => isInSeedScope(scopeSeedUrl, e.url) && !isNonHtmlUrl(e.url),
      );
      const robotAllowedEntries: typeof entries = [];
      for (const e of scopedEntries) {
        if (robots && !robots.allows(e.url)) {
          noteSkippedRobots(e.url);
          await notifySkippedRobots(e.url);
        } else {
          robotAllowedEntries.push(e);
        }
      }
      const toQueue = skipUrls?.size
        ? robotAllowedEntries.filter((e) => !skipUrls.has(e.url))
        : robotAllowedEntries;
      await crawler.addRequests(
        toQueue.map((e) => ({ url: e.url, userData: { sitemapLastmod: e.lastmod } })),
      );
    } else {
      // Crawl mode: just the seed URL at depth=0. Crawlee enqueues its
      // out-links subject to the source's depth setting.
      await crawler.addRequests([{ url: input.seedUrl, userData: { depth: 0 } }]);
    }

    await crawler.run();
    for (const url of skippedRobotsUrls) {
      await notifySkippedRobots(url);
    }
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    await crawler.teardown();
    rmSync(storageDir, { recursive: true, force: true });
  }

  return {
    okCount,
    unchangedCount,
    failedCount,
    skippedCount,
    skippedRobotsCount,
    robotsBlockedSeed: false,
    skippedByContentType,
    skippedUnavailableCount: skippedUnavailable,
    robots: robotsSnapshot,
  };
}
