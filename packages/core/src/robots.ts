// SPDX-License-Identifier: AGPL-3.0-only
import robotsParser from "robots-parser";
import { noopLogger } from "./logger";
import { DEFAULT_USER_AGENT, type CrawlerRuntimeOptions } from "./options";

const ROBOTS_TIMEOUT_MS = 4_000;

export type RobotsPolicy = {
  found: boolean;
  fetched: boolean;
  allows(url: string): boolean;
  crawlDelaySeconds: number | null;
  declaredSitemaps: string[];
  error: string | null;
};

/**
 * Serializable snapshot of a robots.txt evaluation, persisted on
 * `crawl_source.robots_state`. Written on every crawl run and by the manual
 * "sync robots.txt" action so the Source detail page can show what robots.txt
 * says and how we act on it without re-fetching on each view. `allows()` is
 * collapsed to `seedAllowed` (the only URL we evaluate at snapshot time).
 */
export type RobotsSnapshot = {
  fetchedAt: string;
  found: boolean;
  fetched: boolean;
  crawlDelaySeconds: number | null;
  declaredSitemaps: string[];
  seedAllowed: boolean;
  error: string | null;
};

export function buildRobotsSnapshot(policy: RobotsPolicy, seedUrl: string): RobotsSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    found: policy.found,
    fetched: policy.fetched,
    crawlDelaySeconds: policy.crawlDelaySeconds,
    declaredSitemaps: policy.declaredSitemaps,
    seedAllowed: policy.allows(seedUrl),
    error: policy.error,
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function effectiveMaxRequestsPerMinute(
  configured: number | undefined,
  crawlDelaySeconds: number | null,
): number | undefined {
  if (!configured || !crawlDelaySeconds || crawlDelaySeconds <= 0) return configured;
  return Math.min(configured, Math.max(1, Math.floor(60 / crawlDelaySeconds)));
}

export async function loadRobotsPolicyForUrl(
  seedUrl: string,
  fetcher: FetchLike = fetch,
  options?: CrawlerRuntimeOptions,
): Promise<RobotsPolicy> {
  const logger = options?.logger ?? noopLogger;
  const userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", new URL(seedUrl).origin).href;
  } catch {
    return allowAll("invalid seed URL");
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ROBOTS_TIMEOUT_MS);
  try {
    const res = await fetcher(robotsUrl, {
      signal: ac.signal,
      headers: { "user-agent": userAgent, accept: "text/plain,*/*;q=0.5" },
      redirect: "follow",
    });
    if (res.status === 404 || res.status === 410) {
      return allowAll(null, { found: false, fetched: false });
    }
    if (!res.ok) {
      return allowAll(`HTTP ${res.status} for ${robotsUrl}`, { found: true, fetched: false });
    }

    const body = await res.text();
    const parsed = robotsParser(robotsUrl, body);
    return {
      found: true,
      fetched: true,
      allows(url: string) {
        return parsed.isAllowed(url, userAgent) ?? true;
      },
      crawlDelaySeconds: parsed.getCrawlDelay(userAgent) ?? null,
      declaredSitemaps: parsed.getSitemaps(),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug({ err: message, robotsUrl }, "robots.txt unreachable; allowing crawl");
    return allowAll(message, { found: false, fetched: false });
  } finally {
    clearTimeout(timer);
  }
}

function allowAll(
  error: string | null,
  overrides: Partial<Pick<RobotsPolicy, "found" | "fetched">> = {},
): RobotsPolicy {
  return {
    found: overrides.found ?? false,
    fetched: overrides.fetched ?? false,
    allows: () => true,
    crawlDelaySeconds: null,
    declaredSitemaps: [],
    error,
  };
}
