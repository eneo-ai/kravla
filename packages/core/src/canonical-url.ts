// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Resolve the canonical origin for a user-entered source URL by following
 * HTTP redirects. Many Swedish muni hosts redirect apex → www (or vice
 * versa); storing the un-canonicalized URL on `crawl_source.url` breaks
 * downstream hostname-equality checks in `isInSeedScope`, so every
 * sitemap entry on the redirect target is filtered out and the crawl
 * silently produces zero pages.
 *
 * We probe once at creation time, swap the origin if it changed, and
 * preserve the user's original path + query. Probe failures fall back to
 * the user-typed URL — better to let the run surface the error than to
 * reject creation when the host happens to be down.
 */
import { noopLogger } from "./logger";
import { buildUserAgent, DEFAULT_USER_AGENT, type CrawlerRuntimeOptions } from "./options";

const PROBE_TIMEOUT_MS = 5_000;

export async function canonicalizeSourceUrl(
  rawUrl: string,
  options?: CrawlerRuntimeOptions,
): Promise<string> {
  const logger = options?.logger ?? noopLogger;
  const userAgent = buildUserAgent(options?.userAgent ?? DEFAULT_USER_AGENT, "url-canonicalizer");
  let input: URL;
  try {
    input = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(input.toString(), {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: { "user-agent": userAgent, accept: "text/html,*/*;q=0.5" },
    });
    const finalUrl = new URL(res.url || input.toString());
    if (finalUrl.origin === input.origin) return rawUrl;

    const rebuilt = new URL(input.pathname + input.search + input.hash, finalUrl.origin);
    logger.info(
      { rawUrl, canonical: rebuilt.toString(), finalUrl: res.url },
      "canonicalized source URL via redirect",
    );
    return rebuilt.toString();
  } catch (err) {
    logger.warn(
      { rawUrl, err: err instanceof Error ? err.message : String(err) },
      "canonical URL probe failed, keeping user-provided URL",
    );
    return rawUrl;
  } finally {
    clearTimeout(timer);
  }
}
