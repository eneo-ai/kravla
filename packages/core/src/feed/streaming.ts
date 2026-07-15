// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Adapter exposing the feed crawler under the streaming
 * `runCrawl(input) → CrawlOutcome` contract `processCrawlRun` expects, the
 * same way `../open-eplatform/streaming.ts` bridges its batch runner.
 *
 * Each feed item becomes one `CrawlPage` of `metadata.provider = "feed"`, so
 * `persistPage` writes it as `source_document.kind = "feed_entry"`. The dedup
 * key (`page.url`) is the item's `guid`/`id`; the citable `uri` is the item's
 * link (resolved in `persistPage`).
 *
 * Linked-document handling (operator opts in via `indexLinkedFiles`):
 *  - link is a supported document (PDF/DOCX/…) → emitted as `page.fileLinks`,
 *    ingested by the existing crawled-file pipeline as a `file` document
 *    attached to the entry.
 *  - link is HTML → fetched and its article body is appended to the entry's
 *    text, keeping one citable `feed_entry` document per item.
 *
 * `robots`, `depth`, `crawlScope`, sitemap inputs are ignored, exactly as the
 * open_eplatform adapter ignores them.
 */
import { noopLogger } from "../logger";
import { buildUserAgent, DEFAULT_USER_AGENT } from "../options";
import { extractContent } from "../extract";
import { fileLinkForUrl, isNonHtmlUrl, type FileLink } from "../file-links";
import { toIsoDate, type PageDateSources } from "../page-dates";
import type { CrawlOutcome, CrawlPage, CrawlRunnerInput } from "../crawl-runner";
import { fetchAndParseFeed } from "./parse";
import { FEED_PROVIDER, type FeedEntryMetadata, type FeedItem } from "./types";

const ARTICLE_FETCH_TIMEOUT_MS = 15_000;

const EMPTY_OUTCOME: CrawlOutcome = {
  okCount: 0,
  unchangedCount: 0,
  failedCount: 0,
  skippedCount: 0,
  skippedRobotsCount: 0,
  robotsBlockedSeed: false,
  skippedByContentType: 0,
  robots: null,
};

/**
 * Fetch an entry's HTML link target and return its extracted article markdown,
 * or null if the fetch/extract fails or returns nothing. Failures are
 * swallowed — a broken article link must not fail the whole feed run.
 */
async function fetchArticleText(url: string, userAgent: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARTICLE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (ct && !ct.includes("html")) return null;
    const html = await res.text();
    const extracted = extractContent(html, url);
    return extracted.markdown.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildPage(
  item: FeedItem,
  feedUrl: string,
  feedTitle: string | null,
  indexLinkedFiles: boolean,
  includeTabularFileLinks: boolean,
  userAgent: string,
): Promise<CrawlPage> {
  const metadata: FeedEntryMetadata = {
    provider: FEED_PROVIDER,
    link: item.link,
    published: item.published,
    updated: item.updated,
    author: item.author,
    categories: item.categories,
    feedTitle,
    feedUrl,
  };

  const textParts: string[] = [];
  if (item.summary) textParts.push(item.summary);

  const fileLinks: FileLink[] = [];
  if (item.link && indexLinkedFiles) {
    if (isNonHtmlUrl(item.link)) {
      const fl = fileLinkForUrl(item.link, item.title ?? undefined, {
        includeTabular: includeTabularFileLinks,
      });
      if (fl) fileLinks.push(fl);
    } else {
      const article = await fetchArticleText(item.link, userAgent);
      if (article) textParts.push(article);
    }
  }

  // Feed items state their own dates — normalize them straight onto the
  // first-class fields (the raw strings stay in `metadata.published/updated`).
  const publishedAt = toIsoDate(item.published);
  const modifiedAt = toIsoDate(item.updated);
  const dateSources: PageDateSources = {};
  if (publishedAt) dateSources.publishedAt = "feed";
  if (modifiedAt) dateSources.modifiedAt = "feed";

  return {
    url: item.id,
    title: item.title,
    rawText: textParts.join("\n\n"),
    etag: null,
    lastModified: null,
    publishedAt,
    modifiedAt,
    dateSources: publishedAt || modifiedAt ? dateSources : null,
    fetchedAt: new Date().toISOString(),
    fileLinks,
    metadata,
  };
}

export async function runFeedAsStreaming(input: CrawlRunnerInput): Promise<CrawlOutcome> {
  if (input.signal?.aborted) return EMPTY_OUTCOME;

  const logger = input.logger ?? noopLogger;
  const log = logger.child({ component: "feed-runner", feedUrl: input.seedUrl });
  const userAgent = buildUserAgent(input.userAgent ?? DEFAULT_USER_AGENT, "feed-loader");
  const parsed = await fetchAndParseFeed(input.seedUrl, input.cacheHints?.get(input.seedUrl), {
    logger,
    userAgent: input.userAgent,
  });

  if (parsed.notModified) {
    log.info("feed unchanged (304)");
    return EMPTY_OUTCOME;
  }

  let okCount = 0;
  for (const item of parsed.items) {
    if (input.signal?.aborted) break;
    if (input.skipUrls?.has(item.id)) continue;
    const page = await buildPage(
      item,
      input.seedUrl,
      parsed.feedTitle,
      Boolean(input.indexLinkedFiles),
      input.includeTabularFileLinks === true,
      userAgent,
    );
    await input.onPage?.(page);
    okCount += 1;
  }

  log.info({ items: parsed.items.length, emitted: okCount }, "feed run complete");
  return { ...EMPTY_OUTCOME, okCount };
}
