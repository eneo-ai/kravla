// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Path-scope helpers shared between the live crawler and the dry-run preview.
 *
 * Seed-prefix scope: a CrawlSource seeded at `https://host/upplev` covers
 * only URLs whose pathname is exactly `/upplev` or starts with `/upplev/`
 * (and matches the same hostname). To ingest a full site, seed with the
 * root path.
 *
 * Two consumer shapes:
 *  - `pathPrefixGlobs(seedUrl)` — globs for Crawlee's `enqueueLinks` to
 *    filter discovered links at parse time.
 *  - `isInSeedScope(seedUrl, candidate)` — predicate used by sitemap-mode
 *    crawls to filter `Sitemap.load()` results before queueing them.
 *  - `sitemapSeedScopeUrl(seedUrl, locations)` — strips the sitemap document
 *    from a seed that points directly at one (`https://host/sitemap.xml` →
 *    `https://host/`), so sitemap-mode scope falls back to the site root.
 */

export function isInSeedScope(seedUrl: string, candidateUrl: string): boolean {
  let seed: URL;
  let candidate: URL;
  try {
    seed = new URL(seedUrl);
    candidate = new URL(candidateUrl);
  } catch {
    return false;
  }
  if (seed.hostname !== candidate.hostname) return false;

  const seedPath = normalizePath(seed.pathname);
  const candidatePath = normalizePath(candidate.pathname);

  // Root-of-site seed → no path restriction (all same-hostname matches).
  if (seedPath === "") return true;

  // Exact match OR descends into the seed's subtree.
  return candidatePath === seedPath || candidatePath.startsWith(seedPath + "/");
}

export function pathPrefixGlobs(seedUrl: string): string[] {
  const u = new URL(seedUrl);
  const path = normalizePath(u.pathname);
  if (path === "") {
    return [`${u.origin}/**`];
  }
  return [
    `${u.origin}${path}`,
    `${u.origin}${path}/**`,
    `${u.origin}${path}?**`,
    `${u.origin}${path}#**`,
  ];
}

/**
 * The seed URL that sitemap-mode scope filtering should run against.
 *
 * When the seed points at the sitemap document itself — its URL matches one
 * of the discovered sitemap locations, or its path names an XML document
 * (`https://host/sitemap.xml`) — the sitemap part is stripped and the scope
 * becomes the site root. Page URLs never live "under" the sitemap's own
 * path, so keeping seed-prefix scope there would silently filter out every
 * entry. (Sources created by older Eneo versions store their seed exactly
 * this way.) Any other seed is returned unchanged and keeps its path-prefix
 * scope.
 */
export function sitemapSeedScopeUrl(seedUrl: string, discoveredLocations: string[] = []): string {
  let seed: URL;
  try {
    seed = new URL(seedUrl);
  } catch {
    return seedUrl;
  }
  const seedPath = normalizePath(seed.pathname);
  if (seedPath === "") return seedUrl;

  // Protocol deliberately ignored: robots.txt may declare the location with
  // a different scheme than the stored seed.
  const matchesLocation = discoveredLocations.some((loc) => {
    try {
      const l = new URL(loc);
      return (
        l.hostname === seed.hostname &&
        normalizePath(l.pathname) === seedPath &&
        l.search === seed.search
      );
    } catch {
      return false;
    }
  });
  // A seed whose path names an XML document can never be a meaningful
  // page-prefix scope, so treat it as the sitemap pointer it is. This arm
  // covers the crawl runner, which receives pre-resolved URL lists without
  // discovery info.
  const namesXmlDocument = /\.xml(\.gz)?$/i.test(seedPath);
  return matchesLocation || namesXmlDocument ? `${seed.origin}/` : seedUrl;
}

function normalizePath(path: string): string {
  // Strip trailing slash(es), but preserve the leading slash. Empty path
  // after normalization means "root of site".
  return path.replace(/\/+$/, "");
}
