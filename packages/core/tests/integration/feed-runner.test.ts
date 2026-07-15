// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Feed runner (`runFeedAsStreaming`) over a fixture HTTP server.
 *
 * Covers RSS + Atom parsing, the dedup-id rule (guid → id → link), the
 * conditional-GET 304 short-circuit, and the linked-document behavior:
 * an HTML link is fetched and folded into the entry text; a PDF link is
 * emitted as a `fileLink` for the crawled-file pipeline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFeedAsStreaming } from "../../src/feed/streaming";
import type { CacheHint, CrawlPage } from "../../src/crawl-runner";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer;

const FEED_ETAG = 'W/"feed-v1"';

function rssXml(origin: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    "<title>Test Feed</title>",
    `<item><title>Entry One</title><link>${origin}/articles/one</link>` +
      "<guid>guid-1</guid><description>Summary one.</description>" +
      "<pubDate>Tue, 03 Jun 2025 10:00:00 GMT</pubDate><category>news</category></item>",
    // No guid → dedup falls back to the link.
    `<item><title>Entry Two</title><link>${origin}/docs/two.pdf</link>` +
      "<description>Summary two.</description></item>",
    "</channel></rss>",
  ].join("\n");
}

function atomXml(origin: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "<title>Atom Feed</title>",
    `<entry><title>Atom One</title><link href="${origin}/articles/atom-one"/>` +
      "<id>atom-id-1</id><summary>Atom summary.</summary>" +
      "<updated>2025-06-03T10:00:00Z</updated></entry>",
    "</feed>",
  ].join("\n");
}

beforeAll(async () => {
  server = await startFixtureServer([{ path: "/", title: "root", bodyHtml: "<p>root</p>" }]);
  const origin = server.url;
  server.setFixtures([
    {
      path: "/rss",
      title: "rss",
      bodyHtml: "",
      contentType: "application/rss+xml",
      rawBody: rssXml(origin),
      etag: FEED_ETAG,
    },
    {
      path: "/atom",
      title: "atom",
      bodyHtml: "",
      contentType: "application/atom+xml",
      rawBody: atomXml(origin),
    },
    {
      path: "/articles/one",
      title: "Article One",
      bodyHtml:
        "<article><h1>Article One</h1><p>" +
        "This is the full article body that the feed entry links to. ".repeat(8) +
        "</p></article>",
    },
    {
      path: "/docs/two.pdf",
      title: "pdf",
      bodyHtml: "",
      contentType: "application/pdf",
      rawBody: "%PDF-1.4 fake",
    },
    {
      // A normal HTML page that advertises its feed via autodiscovery — the
      // case where the source URL is a page, not a feed.
      path: "/news",
      title: "News",
      bodyHtml: `<link rel="alternate" type="application/rss+xml" href="${origin}/rss"><p>news</p>`,
    },
  ]);
});

afterAll(async () => {
  await server.close();
});

async function collect(
  feedPath: string,
  opts: { indexLinkedFiles?: boolean; cacheHints?: Map<string, CacheHint> } = {},
): Promise<CrawlPage[]> {
  const pages: CrawlPage[] = [];
  await runFeedAsStreaming({
    seedUrl: `${server.url}${feedPath}`,
    crawlType: "feed",
    depth: 0,
    indexLinkedFiles: opts.indexLinkedFiles,
    cacheHints: opts.cacheHints,
    onPage: async (p) => {
      pages.push(p);
    },
  });
  return pages;
}

describe("feed runner", () => {
  it("parses RSS items, using guid then link as the dedup id", async () => {
    const pages = await collect("/rss");
    expect(pages).toHaveLength(2);

    const one = pages[0]!;
    const two = pages[1]!;
    expect(one.url).toBe("guid-1");
    expect(one.title).toBe("Entry One");
    expect(one.metadata?.provider).toBe("feed");
    expect(one.metadata?.link).toBe(`${server.url}/articles/one`);
    expect(one.rawText).toContain("Summary one.");
    // pubDate lands as the normalized first-class publish date.
    expect(one.publishedAt).toBe("2025-06-03T10:00:00.000Z");
    expect(one.modifiedAt).toBeNull();
    expect(one.dateSources).toEqual({ publishedAt: "feed" });
    expect(one.fetchedAt).toBeTruthy();
    // Entry Two has no dates at all.
    expect(two.publishedAt).toBeNull();
    expect(two.dateSources).toBeNull();

    // No guid on the second item → the link becomes the id.
    expect(two.url).toBe(`${server.url}/docs/two.pdf`);
  });

  it("parses Atom entries via id/summary", async () => {
    const pages = await collect("/atom");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.url).toBe("atom-id-1");
    expect(pages[0]!.metadata?.link).toBe(`${server.url}/articles/atom-one`);
    expect(pages[0]!.rawText).toContain("Atom summary.");
    // The feed parser folds Atom <updated> into the item's `published`
    // (rss-parser's isoDate mapping), so it surfaces as publishedAt here.
    expect(pages[0]!.publishedAt).toBe("2025-06-03T10:00:00.000Z");
    expect(pages[0]!.dateSources?.publishedAt).toBe("feed");
  });

  it("without linked-document indexing, leaves entry text and fileLinks bare", async () => {
    const pages = await collect("/rss");
    expect(pages[0]!.rawText).not.toContain("full article body");
    expect(pages[0]!.fileLinks).toHaveLength(0);
    expect(pages[1]!.fileLinks).toHaveLength(0);
  });

  it("with linked-document indexing, folds HTML articles and attaches PDFs", async () => {
    const pages = await collect("/rss", { indexLinkedFiles: true });
    // HTML link → article body appended to the entry text.
    expect(pages[0]!.rawText).toContain("full article body");
    expect(pages[0]!.fileLinks).toHaveLength(0);
    // PDF link → emitted as a fileLink, not inlined.
    expect(pages[1]!.fileLinks).toHaveLength(1);
    expect(pages[1]!.fileLinks[0]?.url).toBe(`${server.url}/docs/two.pdf`);
    expect(pages[1]!.fileLinks[0]?.mimeType).toBe("application/pdf");
  });

  it("follows RSS autodiscovery when the source URL is a page", async () => {
    const pages = await collect("/news");
    // Same items as the /rss feed the page advertises.
    expect(pages).toHaveLength(2);
    expect(pages[0]!.url).toBe("guid-1");
    expect(pages[0]!.metadata?.provider).toBe("feed");
  });

  it("short-circuits on a 304 Not Modified", async () => {
    const hints = new Map<string, CacheHint>([
      [`${server.url}/rss`, { etag: FEED_ETAG, lastModified: null }],
    ]);
    const pages = await collect("/rss", { cacheHints: hints });
    expect(pages).toHaveLength(0);
  });
});
