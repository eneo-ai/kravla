// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Resolves normalized page timestamps from the date signals the crawl
 * already collects but leaves scattered across enricher namespaces:
 * JSON-LD `datePublished`/`dateModified`, `article:*` meta tags, Dublin
 * Core `dcterms.*`, visible `<time>` elements, and the sitemap's
 * per-URL `<lastmod>`.
 *
 * The HTTP `Last-Modified` header is deliberately NOT a source: on
 * dynamic CMS pages it reflects template render time (often ≈ fetch
 * time), so it would produce wrong-but-plausible content dates. It
 * stays available verbatim on `CrawlPage.lastModified` as a cache hint.
 *
 * Precedence is descending explicitness of publisher intent and
 * per-content (vs per-template) granularity: JSON-LD and `article:*`
 * are deliberate machine-readable statements about the content; dcterms
 * is reliable on Sitevision but archival; `<time>` is a visible-DOM
 * heuristic; sitemap lastmod is per-URL but frequently auto-stamped by
 * the CMS. The two fields resolve independently — no cross-field
 * cleverness like dropping a modifiedAt that precedes publishedAt.
 */

/** Which signal a resolved date came from — stored for downstream trust weighting. */
export type DateSource =
  | "json-ld"
  | "meta-article"
  | "dcterms"
  | "time-element"
  | "sitemap-lastmod"
  | "feed";

/** Per-field provenance. Kept as an object (not parallel fields) so it maps onto one jsonb column and can grow. */
export type PageDateSources = {
  publishedAt?: DateSource;
  modifiedAt?: DateSource;
};

export type PageDates = {
  /** Normalized publish/creation date, full ISO 8601 UTC, or null. */
  publishedAt: string | null;
  /** Normalized content-modification date, full ISO 8601 UTC, or null. */
  modifiedAt: string | null;
  /** Null when both dates are null. */
  dateSources: PageDateSources | null;
};

// Sanity window for parsed dates. Below the floor is epoch-zero/garbage
// markup; above the ceiling is publisher clock skew beyond tolerance.
const MIN_DATE_MS = Date.UTC(1990, 0, 1);
const MAX_FUTURE_SKEW_MS = 36 * 60 * 60 * 1000;

/**
 * Lenient string → full ISO 8601 UTC normalization. Returns null for
 * non-strings, unparseable values, and dates outside the sanity window.
 * Date-only inputs normalize to UTC midnight; original timezone offsets
 * collapse to UTC.
 */
export function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  if (ms < MIN_DATE_MS || ms > Date.now() + MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

type Candidate = { source: DateSource; value: unknown };

export function resolvePageDates(input: {
  /** Merged enricher output (`runEnrichers().metadata`). */
  metadata: Record<string, unknown> | null | undefined;
  /** ISO string carried from the sitemap entry's `<lastmod>` via request userData. */
  sitemapLastmod?: string | null;
}): PageDates {
  const m = input.metadata ?? {};

  const publishedCandidates: Candidate[] = [
    { source: "json-ld", value: pick(m, "jsonLd", "article", "publishedAt") },
    { source: "meta-article", value: pick(m, "article", "publishedAt") },
    { source: "dcterms", value: pick(m, "dcterms", "issued") },
    { source: "dcterms", value: pick(m, "dcterms", "created") },
    { source: "dcterms", value: pick(m, "dcterms", "date") },
    { source: "time-element", value: pick(m, "time", "publishedAt") },
    // Sitemap lastmod and HTTP Last-Modified are modification signals;
    // neither ever feeds publishedAt.
  ];

  const modifiedCandidates: Candidate[] = [
    { source: "json-ld", value: pick(m, "jsonLd", "article", "modifiedAt") },
    { source: "meta-article", value: pick(m, "article", "modifiedAt") },
    { source: "dcterms", value: pick(m, "dcterms", "modified") },
    { source: "time-element", value: pick(m, "time", "modifiedAt") },
    { source: "sitemap-lastmod", value: input.sitemapLastmod },
  ];

  const published = firstValid(publishedCandidates);
  const modified = firstValid(modifiedCandidates);

  const dateSources: PageDateSources = {};
  if (published) dateSources.publishedAt = published.source;
  if (modified) dateSources.modifiedAt = modified.source;

  return {
    publishedAt: published?.iso ?? null,
    modifiedAt: modified?.iso ?? null,
    dateSources: published || modified ? dateSources : null,
  };
}

function firstValid(candidates: Candidate[]): { iso: string; source: DateSource } | null {
  for (const c of candidates) {
    const iso = toIsoDate(c.value);
    if (iso) return { iso, source: c.source };
  }
  return null;
}

/** Safe nested lookup into the untyped merged-metadata bag. */
function pick(obj: Record<string, unknown>, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
