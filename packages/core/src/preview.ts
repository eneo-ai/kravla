// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dry-run / preview for a candidate CrawlSource. Operator gets a count
 * estimate without committing the source to the DB.
 *
 * Strategy = "hybrid":
 *   1. Sitemap probe — find via robots.txt `Sitemap:` directives, then
 *      fall back to `/sitemap.xml` + `/sitemap_index.xml`. Cheap (~1-3 HTTP
 *      requests) when available. Often unreliable on hand-rolled sites.
 *   2. Sample crawl — capped Crawlee run (`maxRequestsPerCrawl: N`) that
 *      counts every unique URL discovered (visited + linked-from-visited).
 *      Slower but works for any site. Gives a lower-bound estimate.
 *   3. Cross-check — if both numbers disagree by >2×, emit a warning
 *      ("sitemap may be stale" or "links suggest more pages than sitemap").
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Importing directly from the leaf @crawlee/* subpackages — using the
// umbrella `crawlee` import pulls in `@crawlee/puppeteer`, whose internals
// require.resolve('puppeteer/package.json'). The Next.js bundler traces
// that statically and fails the build even though we never run that path.
import { CheerioCrawler } from "@crawlee/cheerio";
import { Configuration, LogLevel, log as crawleeLog } from "@crawlee/core";
import { noopLogger } from "./logger";
import { buildUserAgent, DEFAULT_USER_AGENT, type CrawlerRuntimeOptions } from "./options";
import { isInSeedScope, pathPrefixGlobs, sitemapSeedScopeUrl } from "./scope";
import { loadSitemap } from "./sitemap";
import { canonicalizeSourceUrl } from "./canonical-url";
import { isExcludedCrawlUrl } from "./url-exclusions";
import { loadRobotsPolicyForUrl } from "./robots";

export type BasicAuth = { user: string; password: string };

export type PreviewInput = {
  url: string;
  crawlType: "crawl" | "sitemap";
  depth: number;
  crawlScope?: "depth_limited" | "path_prefix";
  httpAuth?: BasicAuth | null;
  excludeUrlPatterns?: string[];
  maxSampleFetches?: number;
};

export type SeedProbe = {
  reachable: boolean;
  httpStatus: number | null;
  contentType: string | null;
  responseTimeMs: number | null;
  /** Populated if the HEAD request errored at the network layer (DNS, TCP, TLS). */
  error: string | null;
};

export type SitemapProbe = {
  found: boolean;
  locations: string[];
  /** URLs in the sitemap matching the seed-prefix scope — what we'd ingest. */
  urlCount: number;
  /** Total URLs in the sitemap (any path). Lets operators see the proportion. */
  totalUrlsInSitemap: number;
  sampleUrls: string[];
};

export type SampleCrawlResult = {
  pagesFetched: number;
  urlsDiscovered: number;
  sampleUrls: string[];
  hitCap: boolean;
};

export type RobotsResult = {
  /** robots.txt file exists at the canonical location. */
  found: boolean;
  /** We were able to fetch and parse it (false if 4xx/5xx/network failure). */
  fetched: boolean;
  /** Whether the User-agent: * rules allow the seed URL. */
  allowsSeed: boolean;
  /** Crawl-delay directive in seconds (null if not declared). */
  crawlDelaySeconds: number | null;
  /** Sitemap: directives declared in robots.txt. */
  declaredSitemaps: string[];
};

export type PreviewResult = {
  method: "hybrid";
  seed: SeedProbe;
  robotsTxt: RobotsResult;
  sitemap: SitemapProbe;
  sampleCrawl: SampleCrawlResult;
  warnings: string[];
};

const DEFAULT_MAX_FETCHES = 50;

export async function previewCrawlSource(
  input: PreviewInput,
  options?: CrawlerRuntimeOptions,
): Promise<PreviewResult> {
  // Mirror the real create path (`crawl-sources.ts` canonicalizes before
  // persisting): resolve apex→www redirects up front so every probe — and
  // especially the sitemap scope filter — runs against the host that will
  // actually be crawled. Without this, a seed typed as `alingsas.se` keeps the
  // apex host while the sitemap lives on `www.alingsas.se`, so `isInSeedScope`
  // drops every URL and the preview wrongly reports "no sitemap".
  const url = await canonicalizeSourceUrl(input.url, options);
  const canonicalInput = url === input.url ? input : { ...input, url };

  // Fast seed check first — if it's not reachable, we still run the rest in
  // case there's e.g. a sitemap-only setup, but the result is clearly flagged.
  const [seed, robotsTxt, sitemap, sampleCrawl] = await Promise.all([
    probeSeed(url, input.httpAuth ?? null, options),
    probeRobots(url, options),
    probeSitemap(url, input.httpAuth ?? null, options),
    runSampleCrawl(canonicalInput, input.maxSampleFetches ?? DEFAULT_MAX_FETCHES, options),
  ]);

  return {
    method: "hybrid",
    seed,
    robotsTxt,
    sitemap,
    sampleCrawl,
    warnings: deriveWarnings({ seed, sitemap, sampleCrawl, robotsTxt }),
  };
}

// ---------------------------------------------------------------------------
// Seed reachability probe (HEAD with fallback to GET)
// ---------------------------------------------------------------------------

const SEED_PROBE_TIMEOUT_MS = 8_000;

async function probeSeed(
  url: string,
  auth: BasicAuth | null,
  options?: CrawlerRuntimeOptions,
): Promise<SeedProbe> {
  const headers: Record<string, string> = {
    "User-Agent": buildUserAgent(options?.userAgent ?? DEFAULT_USER_AGENT, "preview"),
  };
  if (auth) {
    headers.Authorization =
      "Basic " + Buffer.from(`${auth.user}:${auth.password}`).toString("base64");
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SEED_PROBE_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    // Try HEAD first; many sites return 405 — fall back to a small GET if so.
    let res = await fetch(url, { method: "HEAD", headers, signal: ac.signal });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", headers, signal: ac.signal });
    }
    return {
      reachable: res.ok,
      httpStatus: res.status,
      contentType: res.headers.get("content-type"),
      responseTimeMs: Math.round(performance.now() - t0),
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      httpStatus: null,
      contentType: null,
      responseTimeMs: Math.round(performance.now() - t0),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Sitemap probe
// ---------------------------------------------------------------------------

async function probeSitemap(
  seedUrl: string,
  _auth: BasicAuth | null,
  options?: CrawlerRuntimeOptions,
): Promise<SitemapProbe> {
  // Native loader — the same path the live crawl uses (process-run →
  // loadSitemap). Crawlee's `Sitemap.load` routes through got-scraping, whose
  // HTTP/2 bug silently returns 0 URLs on CDN-fronted .se hosts, so the preview
  // disagreed with both the gate probe and the real crawl.
  const { entries, discoveredLocations } = await loadSitemap(seedUrl, options);
  // A seed pointing at the sitemap document itself scopes to the site root
  // (sitemap part stripped), mirroring crawl-runner.ts's sitemap branch.
  const scopeSeed = sitemapSeedScopeUrl(seedUrl, discoveredLocations);
  const inScope = new Set<string>();
  for (const e of entries) {
    if (isInSeedScope(scopeSeed, e.url)) inScope.add(e.url);
  }

  return {
    // A sitemap was found if it resolved to any URLs at all. The in-scope
    // subset (`urlCount`) can legitimately be smaller for a sub-path seed; it
    // must not flip "found" to false the way the old in-scope-only check did.
    found: entries.length > 0,
    locations: discoveredLocations,
    urlCount: inScope.size,
    totalUrlsInSitemap: entries.length,
    sampleUrls: Array.from(inScope).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Sample crawl — capped, link-counting only (no body extraction)
// ---------------------------------------------------------------------------

async function runSampleCrawl(
  input: PreviewInput,
  maxFetches: number,
  options?: CrawlerRuntimeOptions,
): Promise<SampleCrawlResult> {
  const logger = options?.logger ?? noopLogger;
  const discovered = new Set<string>();
  let pagesFetched = 0;

  const storageDir = mkdtempSync(join(tmpdir(), "crawlee-preview-"));
  const config = new Configuration({
    persistStorage: false,
    storageClientOptions: { localDataDirectory: storageDir },
  });

  const basicAuthHeader = input.httpAuth
    ? "Basic " + Buffer.from(`${input.httpAuth.user}:${input.httpAuth.password}`).toString("base64")
    : null;

  const robots = await loadRobotsPolicyForUrl(input.url, fetch, options);
  if (!robots.allows(input.url)) {
    rmSync(storageDir, { recursive: true, force: true });
    return { pagesFetched: 0, urlsDiscovered: 0, sampleUrls: [], hitCap: false };
  }

  const seedHost = new URL(input.url).host;
  const crawlFullPath = input.crawlType === "crawl" && input.crawlScope === "path_prefix";
  const previewCrawlerLog = crawleeLog.child({ prefix: "PreviewCrawler" });
  previewCrawlerLog.setLevel(LogLevel.OFF);

  const crawler = new CheerioCrawler(
    {
      log: previewCrawlerLog,
      maxConcurrency: 1,
      // Preview path is fast-fail by design: zero retries, no session pool
      // rotation. We also skip Crawlee's robots.txt fetch (which classifies
      // failures as "session errors" outside the retry counter, leading to
      // many-thousand-retry loops on unreachable seeds). `probeRobots` does
      // the robots.txt check separately, with its own bounded timeout.
      maxRequestRetries: 0,
      maxSessionRotations: 0,
      useSessionPool: false,
      requestHandlerTimeoutSecs: 10,
      respectRobotsTxtFile: false,
      maxRequestsPerCrawl: maxFetches,
      maxCrawlDepth: input.crawlType === "crawl" && !crawlFullPath ? input.depth : undefined,
      preNavigationHooks: [
        // See crawl-runner.ts for the HTTP/2 disable rationale. The preview's
        // sample crawl hits arbitrary operator-provided sites and must
        // tolerate the same CDN/origin oddities.
        async (_ctx, gotOptions) => {
          (gotOptions as { http2?: boolean }).http2 = false;
        },
        ...(basicAuthHeader
          ? [
              async ({ request }: { request: { headers?: Record<string, string> } }) => {
                request.headers = { ...(request.headers ?? {}), Authorization: basicAuthHeader };
              },
            ]
          : []),
      ],
      async requestHandler({ $, request, enqueueLinks }) {
        pagesFetched += 1;
        const here = request.loadedUrl ?? request.url;
        const currentDepth =
          typeof request.userData.depth === "number" ? request.userData.depth : 0;
        discovered.add(stripFragment(here));

        // Count linked URLs as "discovered" without fetching them.
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;
          try {
            const u = new URL(href, here);
            if (
              u.host === seedHost &&
              robots.allows(u.toString()) &&
              !isExcludedCrawlUrl(u.toString(), input.excludeUrlPatterns)
            ) {
              discovered.add(stripFragment(u.toString()));
            }
          } catch {
            /* invalid href */
          }
        });

        // Drive further fetches when depth allows. Path-scoped so the
        // sample count reflects what the real crawl would do — matching
        // crawl-runner.ts's `pathPrefixGlobs` behavior.
        if (input.crawlType === "crawl" && (crawlFullPath || currentDepth < input.depth)) {
          await enqueueLinks({
            strategy: "same-hostname",
            globs: pathPrefixGlobs(input.url),
            transformRequestFunction: (nextRequest) => {
              if (isExcludedCrawlUrl(nextRequest.url, input.excludeUrlPatterns)) return false;
              if (!robots.allows(nextRequest.url)) return false;
              nextRequest.userData = {
                ...nextRequest.userData,
                depth: currentDepth + 1,
              };
              return nextRequest;
            },
          });
        }
      },
    },
    config,
  );

  // Hard wall-clock cap. Even with retries disabled, Crawlee can re-queue a
  // failing request via its session-error path. We don't want a preview to
  // hang indefinitely on a misbehaving site.
  const HARD_CAP_MS = 20_000;
  try {
    await crawler.addRequests([{ url: input.url, userData: { depth: 0 } }]);
    await Promise.race([
      crawler.run(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          logger.warn({ url: input.url }, "preview sample-crawl hit hard timeout");
          resolve();
        }, HARD_CAP_MS),
      ),
    ]);
  } finally {
    await crawler.teardown();
    rmSync(storageDir, { recursive: true, force: true });
  }

  return {
    pagesFetched,
    urlsDiscovered: discovered.size,
    sampleUrls: Array.from(discovered).slice(0, 10),
    hitCap: pagesFetched >= maxFetches,
  };
}

function stripFragment(url: string): string {
  const idx = url.indexOf("#");
  return idx === -1 ? url : url.slice(0, idx);
}

// ---------------------------------------------------------------------------
// robots.txt probe
// ---------------------------------------------------------------------------

async function probeRobots(
  seedUrl: string,
  options?: CrawlerRuntimeOptions,
): Promise<RobotsResult> {
  const robots = await loadRobotsPolicyForUrl(seedUrl, fetch, options);
  return {
    found: robots.found,
    fetched: robots.fetched,
    allowsSeed: robots.allows(seedUrl),
    crawlDelaySeconds: robots.crawlDelaySeconds,
    declaredSitemaps: robots.declaredSitemaps,
  };
}

// ---------------------------------------------------------------------------
// Cross-check warnings
// ---------------------------------------------------------------------------

function deriveWarnings(args: {
  seed: SeedProbe;
  sitemap: SitemapProbe;
  sampleCrawl: SampleCrawlResult;
  robotsTxt: RobotsResult;
}): string[] {
  const w: string[] = [];

  // ---- Hard stops (operator should NOT proceed) ----------------------------
  if (!args.seed.reachable && args.seed.httpStatus === null) {
    w.push("seed_unreachable_network_error");
  }
  if (args.seed.httpStatus !== null && args.seed.httpStatus >= 400) {
    w.push(`seed_returned_http_${args.seed.httpStatus}`);
  }
  if (args.robotsTxt.found && !args.robotsTxt.allowsSeed) {
    w.push("robots_txt_disallows_seed");
  }

  // ---- Soft flags (operator may want to reconsider) ------------------------
  if (
    args.seed.contentType &&
    !args.seed.contentType.includes("text/html") &&
    !args.seed.contentType.includes("application/xhtml")
  ) {
    w.push(`seed_content_type_${args.seed.contentType.replace(/[^a-zA-Z0-9]+/g, "_")}`);
  }
  if (args.robotsTxt.crawlDelaySeconds !== null && args.robotsTxt.crawlDelaySeconds > 0) {
    w.push(`robots_txt_crawl_delay_${args.robotsTxt.crawlDelaySeconds}s`);
  }
  if (args.sitemap.found && args.sitemap.urlCount > 10_000) {
    w.push("sitemap_url_count_exceeded_10000");
  }
  if (args.sitemap.found && args.sampleCrawl.urlsDiscovered > 0 && args.sitemap.urlCount > 0) {
    const ratio = args.sampleCrawl.urlsDiscovered / args.sitemap.urlCount;
    if (ratio > 2) {
      w.push("sample_crawl_found_far_more_urls_than_sitemap");
    } else if (ratio < 0.25 && args.sitemap.urlCount > 20) {
      w.push("sitemap_url_count_much_higher_than_sample_crawl");
    }
  }
  if (args.sampleCrawl.hitCap) {
    w.push("sample_crawl_hit_max_fetches_cap_estimate_is_lower_bound");
  }
  if (!args.sitemap.found && args.sampleCrawl.urlsDiscovered === 0) {
    w.push("no_pages_discovered");
  }

  return w;
}
