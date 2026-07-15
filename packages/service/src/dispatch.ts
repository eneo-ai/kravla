// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Maps a validated wire request onto the library's streaming-callback seam
 * and routes by crawl_type: `feed` and
 * `open_eplatform` take their streaming adapters, `sitemap` loads the
 * sitemap here (the library expects pre-resolved URLs), `crawl` goes
 * straight to the Crawlee runner.
 */
import {
  loadSitemap,
  runCrawl,
  runFeedAsStreaming,
  runOpenEplatformAsStreaming,
  type CacheHint,
  type CrawlOutcome,
  type CrawlRunnerInput,
  type Logger,
} from "kravla";
import type { ServiceConfig } from "./config";
import type { CrawlRequest } from "./schema";
import { outcomeToWire, pageToWire, robotsToWire, type CrawlEvent, type DoneEvent } from "./wire";

export type CrawlJobResult = { done: DoneEvent };

/**
 * Run one crawl job, emitting wire events through `onEvent` as the library
 * produces them. `onEvent` may be async — the crawler awaits it, so slow
 * consumers (an NDJSON socket, a webhook batch flush) backpressure the
 * crawl naturally. Returns the terminal `done` event; the caller decides
 * how to deliver it.
 */
export async function runCrawlJob(args: {
  request: CrawlRequest;
  config: ServiceConfig;
  logger: Logger;
  signal: AbortSignal;
  onEvent: (event: CrawlEvent) => void | Promise<void>;
}): Promise<CrawlJobResult> {
  const { request, config, logger, signal, onEvent } = args;

  // Wall-clock cap. Aborting mid-run yields a partial-but-valid outcome —
  // identical semantics to a client cancel, so both ride the same signal.
  const maxSecondsController = new AbortController();
  const timer = request.limits?.max_seconds
    ? setTimeout(() => maxSecondsController.abort(), request.limits.max_seconds * 1000)
    : null;
  const jobSignal = AbortSignal.any([signal, maxSecondsController.signal]);

  const cacheHints = request.conditional_gets?.length
    ? new Map<string, CacheHint>(
        request.conditional_gets.map((c) => [
          c.url,
          { etag: c.etag ?? null, lastModified: c.last_modified ?? null },
        ]),
      )
    : undefined;

  const userAgent = request.user_agent ?? config.userAgent;

  const input: CrawlRunnerInput = {
    seedUrl: request.url,
    crawlType: request.crawl_type,
    depth: request.depth,
    crawlScope: request.scope,
    httpAuth: request.http_auth ?? null,
    maxRequestsPerCrawl: request.limits?.max_pages,
    maxRequestsPerMinute: request.limits?.max_requests_per_minute,
    requestDelaySeconds: request.limits?.request_delay_seconds,
    excludeUrlPatterns: request.exclude_url_patterns,
    indexLinkedFiles: request.index_linked_files,
    cacheHints,
    skipUrls: request.skip_urls?.length ? new Set(request.skip_urls) : undefined,
    municipalityName: request.municipality_name,
    signal: jobSignal,
    logger,
    userAgent,
    pageConcurrency: config.pageConcurrency,
    memoryMbytes: config.memoryMbytes,
    requestHandlerTimeoutSecs: config.requestHandlerTimeoutSecs,
    maxHtmlBytes: config.maxHtmlBytes,
    onRobotsLoaded: async (robots) => onEvent({ type: "robots", robots: robotsToWire(robots) }),
    onPage: async (page) => onEvent({ type: "page", page: pageToWire(page) }),
    onUnchanged: async ({ url }) => onEvent({ type: "unchanged", url }),
    onFailed: async (f) =>
      onEvent({
        type: "failed",
        url: f.url,
        status: f.status,
        ...(f.httpStatus !== undefined ? { http_status: f.httpStatus } : {}),
        error_message: f.errorMessage,
      }),
    onSkippedRobots: async ({ url }) => onEvent({ type: "skipped_robots", url }),
    onSkippedUnavailable: async ({ url, httpStatus }) =>
      onEvent({ type: "skipped_unavailable", url, http_status: httpStatus }),
  };

  try {
    let outcome: CrawlOutcome;
    switch (request.crawl_type) {
      case "feed":
        outcome = await runFeedAsStreaming(input);
        break;
      case "open_eplatform":
        outcome = await runOpenEplatformAsStreaming(input);
        break;
      case "sitemap": {
        // Pre-resolved URLs from the caller bypass service-side discovery —
        // callers that already filtered by lastmod keep that filtering.
        if (request.sitemap_urls) {
          outcome = await runCrawl({ ...input, sitemapUrls: request.sitemap_urls });
          break;
        }
        const sitemap = await loadSitemap(request.url, { logger, userAgent });
        // Sitemap-load failures surface as failed events (per-URL) so
        // consumers can record them against the source.
        for (const err of sitemap.errors) {
          await onEvent({
            type: "failed",
            url: err.location,
            status: "fetch_error",
            error_message: `sitemap load: ${err.message}`,
          });
        }
        outcome = await runCrawl({
          ...input,
          // Carry each entry's <lastmod> so it can feed the page's
          // normalized `modified_at` (lowest-priority signal).
          sitemapUrls: sitemap.entries.map((e) => ({
            url: e.url,
            lastmod: e.lastmod ? e.lastmod.toISOString() : null,
          })),
          sitemapDiscoveredLocations: sitemap.discoveredLocations,
        });
        break;
      }
      case "crawl":
        outcome = await runCrawl(input);
        break;
    }
    return {
      done: {
        type: "done",
        status: jobSignal.aborted ? "cancelled" : "completed",
        outcome: outcomeToWire(outcome),
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
