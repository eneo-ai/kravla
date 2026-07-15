// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Library shape ↔ wire shape mappers. Top-level fields are snake_cased;
 * `metadata` and `extra_chunks` payloads pass through verbatim (they are
 * provider-defined and consumers narrow on `metadata.provider`).
 */
import type { CrawlOutcome, CrawlPage, FailedUrl, PreviewResult, RobotsSnapshot } from "kravla";

export type CrawlEvent =
  | { type: "robots"; robots: ReturnType<typeof robotsToWire> }
  | { type: "page"; page: ReturnType<typeof pageToWire> }
  | { type: "unchanged"; url: string }
  | {
      type: "failed";
      url: string;
      status: FailedUrl["status"];
      http_status?: number;
      error_message: string;
    }
  | { type: "skipped_robots"; url: string }
  | { type: "skipped_unavailable"; url: string; http_status: number };

export type DoneEvent = {
  type: "done";
  status: "completed" | "cancelled" | "failed";
  outcome: ReturnType<typeof outcomeToWire> | null;
  /** Present when status === "failed". */
  error?: string;
};

export function robotsToWire(r: RobotsSnapshot) {
  return {
    fetched_at: r.fetchedAt,
    found: r.found,
    fetched: r.fetched,
    crawl_delay_seconds: r.crawlDelaySeconds,
    declared_sitemaps: r.declaredSitemaps,
    seed_allowed: r.seedAllowed,
    error: r.error,
  };
}

export function pageToWire(p: CrawlPage) {
  return {
    url: p.url,
    title: p.title,
    raw_text: p.rawText,
    etag: p.etag,
    // Verbatim HTTP Last-Modified header — a conditional-GET cache hint,
    // not a content date. The normalized content dates are below.
    last_modified: p.lastModified,
    published_at: p.publishedAt,
    modified_at: p.modifiedAt,
    date_sources: p.dateSources
      ? {
          ...(p.dateSources.publishedAt ? { published_at: p.dateSources.publishedAt } : {}),
          ...(p.dateSources.modifiedAt ? { modified_at: p.dateSources.modifiedAt } : {}),
        }
      : null,
    fetched_at: p.fetchedAt,
    file_links: p.fileLinks.map((f) => ({
      url: f.url,
      anchor_text: f.anchorText,
      mime_type: f.mimeType,
    })),
    metadata: p.metadata ?? null,
    extra_chunks: p.extraChunks ?? null,
    detected_platforms:
      p.detectedPlatforms?.map((d) => ({
        detector_id: d.detectorId,
        detector_name: d.detectorName,
        confidence: d.confidence,
        evidence: d.evidence,
        ...(d.metadata ? { metadata: d.metadata } : {}),
      })) ?? null,
  };
}

export function outcomeToWire(o: CrawlOutcome) {
  return {
    ok_count: o.okCount,
    unchanged_count: o.unchangedCount,
    failed_count: o.failedCount,
    skipped_count: o.skippedCount,
    skipped_robots_count: o.skippedRobotsCount ?? 0,
    robots_blocked_seed: o.robotsBlockedSeed ?? false,
    skipped_by_content_type: o.skippedByContentType,
    skipped_unavailable_count: o.skippedUnavailableCount ?? 0,
    robots: o.robots ? robotsToWire(o.robots) : null,
  };
}

export function previewToWire(r: PreviewResult) {
  return {
    method: r.method,
    seed: {
      reachable: r.seed.reachable,
      http_status: r.seed.httpStatus,
      content_type: r.seed.contentType,
      response_time_ms: r.seed.responseTimeMs,
      error: r.seed.error,
    },
    robots_txt: {
      found: r.robotsTxt.found,
      fetched: r.robotsTxt.fetched,
      allows_seed: r.robotsTxt.allowsSeed,
      crawl_delay_seconds: r.robotsTxt.crawlDelaySeconds,
      declared_sitemaps: r.robotsTxt.declaredSitemaps,
    },
    sitemap: {
      found: r.sitemap.found,
      locations: r.sitemap.locations,
      url_count: r.sitemap.urlCount,
      total_urls_in_sitemap: r.sitemap.totalUrlsInSitemap,
      sample_urls: r.sitemap.sampleUrls,
    },
    sample_crawl: {
      pages_fetched: r.sampleCrawl.pagesFetched,
      urls_discovered: r.sampleCrawl.urlsDiscovered,
      sample_urls: r.sampleCrawl.sampleUrls,
      hit_cap: r.sampleCrawl.hitCap,
    },
    warnings: r.warnings,
  };
}
