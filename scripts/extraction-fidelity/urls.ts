// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fixture <-> source-URL mapping. The URL matters because every candidate
 * resolves relative links/images against it, so each fixture must be paired
 * with the URL the HTML was actually served from — the FINAL URL after
 * redirects, not the address you typed (www.stockholm.se redirects
 * cross-domain to start.stockholm; göteborg/malmö drop the www).
 * fetch.ts verifies this and warns when a mapping goes stale.
 *
 * To add a page: add an entry here, run `bun run extraction:fidelity:fetch`,
 * then `bun run extraction:fidelity`. Fixtures without an entry are a hard
 * error in run.ts — a wrong base silently corrupts the link-fidelity diff.
 */
export const FIXTURE_URLS: Record<string, string> = {
  // Municipal homepages — listing/nav-heavy pages where Readability tends to
  // over-prune or bail (the case extract.ts's cheerio fallback exists for).
  "goteborg-home.html": "https://goteborg.se/",
  "malmo-home.html": "https://malmo.se/",
  "stockholm-home.html": "https://start.stockholm/",
  "uppsala-home.html": "https://www.uppsala.se/",
  // Deeper municipal content / service pages — the real RAG ingest target.
  "goteborg-kommun-politik.html": "https://goteborg.se/wps/portal/start/kommun-och-politik",
  "malmo-utbildning.html": "https://malmo.se/Bo-och-leva/Utbildning-och-forskola.html",
  // Article-shaped page — both extractors should agree closely here.
  "en-wikipedia-web-crawler.html": "https://en.wikipedia.org/wiki/Web_crawler",
};
