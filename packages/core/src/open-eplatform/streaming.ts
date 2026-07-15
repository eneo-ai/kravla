// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Adapter that exposes the Open ePlatform runner under the streaming
 * `runCrawl(input) → CrawlOutcome` contract `processCrawlRun` now expects.
 *
 * Upstream restructured the crawl pipeline so the generic `runCrawl` calls
 * `input.onPage` for every fetched page and returns counts only. The Open
 * ePlatform runner still produces an `{ ok, failed }` array (the portal is
 * one big HTML doc — there is no streaming on the wire). This adapter
 * bridges the two: it runs the eplatform fetch+parse, then fans each
 * resulting page through `onPage` / each failure through `onFailed`, and
 * returns the counts the dispatcher expects.
 *
 * Cache hints, sitemap URLs, skip lists, and rate limits in `CrawlRunnerInput`
 * are ignored — the eplatform path doesn't honor conditional GETs (the
 * catalog HTML is replaced wholesale each refresh; the content-hash
 * short-circuit downstream still suppresses re-embedding when nothing
 * changed).
 */
import type { CrawlOutcome, CrawlRunnerInput } from "../crawl-runner";
import { runOpenEplatformCrawl } from "./runner";

export async function runOpenEplatformAsStreaming(input: CrawlRunnerInput): Promise<CrawlOutcome> {
  let okCount = 0;
  let failedCount = 0;

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

  const result = await runOpenEplatformCrawl({
    seedUrl: input.seedUrl,
    municipalityName: input.municipalityName ?? null,
    logger: input.logger,
    userAgent: input.userAgent,
  });

  for (const p of result.ok) {
    if (input.signal?.aborted) break;
    await input.onPage?.(p);
    okCount += 1;
  }
  for (const f of result.failed) {
    if (input.signal?.aborted) break;
    await input.onFailed?.(f);
    failedCount += 1;
  }

  return {
    okCount,
    unchangedCount: 0,
    failedCount,
    skippedCount: 0,
    skippedRobotsCount: 0,
    robotsBlockedSeed: false,
    skippedByContentType: 0,
  };
}
