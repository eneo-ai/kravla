// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Decides the stable identity URL a crawled page is stored under, so that
 * the same content fetched through several URLs collapses to one row instead
 * of many.
 *
 * Two independent causes of duplicate ingestion, two levers:
 *
 *  - Tracking/click query params (`utm_*`, `gclid`, `fbclid`, …) and URL
 *    fragments never change what the server returns. `normalizeCrawlUrl`
 *    strips them so `?utm_source=a` and `?utm_source=b` share one identity
 *    (and, applied at enqueue, one fetch).
 *  - Pagination and print/variant URLs that the site itself declares
 *    equivalent via `<link rel="canonical">`. `resolvePageIdentityUrl`
 *    honors that declaration — but only when the canonical stays on the same
 *    host and inside the crawl's seed scope, so a stray or hostile canonical
 *    can't redirect identity or smuggle content out of the seeded subtree.
 *
 * Both functions return the input unchanged when there is nothing to strip,
 * to avoid rewriting a URL's encoding and making an unchanged page look
 * changed to the downstream content-hash diff.
 */
import { isInSeedScope } from "./scope";

// Removed whenever it appears. Exact-name match, case-insensitive. The
// `utm_` prefix is handled separately below. These are analytics/ad-click
// markers with no effect on server-rendered content; deliberately excludes
// ambiguous params like `ref` or `page` that can be content-bearing.
const TRACKING_QUERY_PARAMS = new Set([
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "yclid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "oly_anon_id",
  "oly_enc_id",
  "_openstat",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lower);
}

export function normalizeCrawlUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  let changed = url.hash !== "";
  url.hash = "";

  const tracking = [...url.searchParams.keys()].filter(isTrackingParam);
  for (const name of tracking) {
    url.searchParams.delete(name);
    changed = true;
  }

  // Reserializing re-encodes the whole query string; only pay that (and the
  // churn risk) when we actually dropped something.
  return changed ? url.toString() : rawUrl;
}

export function resolvePageIdentityUrl(args: {
  fetchedUrl: string;
  canonicalUrl: string | null | undefined;
  scopeSeedUrl: string;
}): string {
  const { fetchedUrl, canonicalUrl, scopeSeedUrl } = args;
  const normalizedFetched = normalizeCrawlUrl(fetchedUrl);
  if (!canonicalUrl) return normalizedFetched;

  let canonical: URL;
  try {
    canonical = new URL(canonicalUrl);
  } catch {
    return normalizedFetched;
  }
  if (canonical.protocol !== "http:" && canonical.protocol !== "https:") {
    return normalizedFetched;
  }
  if (!isInSeedScope(scopeSeedUrl, canonical.toString())) {
    return normalizedFetched;
  }
  return normalizeCrawlUrl(canonical.toString());
}
