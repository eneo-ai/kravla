// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Structured per-entry metadata produced by the feed crawler (RSS / Atom).
 *
 * Stored as `source_document.metadata` (jsonb) alongside `rawText`. The
 * `provider` discriminator is what `persistPage` reads to write
 * `source_document.kind = "feed_entry"`, the way the Open ePlatform crawler's
 * marker yields `kind = "e_service"`.
 */
import { z } from "zod";

export const FEED_PROVIDER = "feed" as const;

export const FeedEntryMetadataSchema = z.object({
  provider: z.literal(FEED_PROVIDER),
  /** The entry's link target — the article/document the item points at. */
  link: z.string().nullable(),
  /** RFC-822 / ISO-8601 publish date as an ISO-8601 string, if the item carried one. */
  published: z.string().nullable(),
  /** Last-updated date (Atom `<updated>`) as an ISO-8601 string, if present. */
  updated: z.string().nullable(),
  /** Item author / `dc:creator`, if present. */
  author: z.string().nullable(),
  /** RSS `<category>` / Atom `<category term>` values; empty when none. */
  categories: z.array(z.string()),
  /** Channel/feed title — useful for the LLM to attribute the source. */
  feedTitle: z.string().nullable(),
  /** The feed URL the operator registered. */
  feedUrl: z.string(),
});

export type FeedEntryMetadata = z.infer<typeof FeedEntryMetadataSchema>;

export function isFeedMetadata(
  m: Record<string, unknown> | null | undefined,
): m is FeedEntryMetadata {
  return !!m && m.provider === FEED_PROVIDER;
}

/** One normalized item from a parsed RSS/Atom feed. */
export type FeedItem = {
  /** Dedup id — the item's `guid`/`id`, falling back to `link`. */
  id: string;
  title: string | null;
  /** The item's link target (resolved absolute), or null. */
  link: string | null;
  /** Plain-text/markdown body assembled from content/summary/description. */
  summary: string;
  published: string | null;
  updated: string | null;
  author: string | null;
  categories: string[];
};

/** Result of fetching + parsing a feed URL. */
export type ParsedFeed = {
  feedTitle: string | null;
  items: FeedItem[];
  /** Response `ETag`, for the next refresh's conditional GET. */
  etag: string | null;
  /** Response `Last-Modified`, for the next refresh's conditional GET. */
  lastModified: string | null;
  /** True when the server answered 304 Not Modified — items is empty. */
  notModified: boolean;
  /**
   * The URL actually parsed as a feed. Differs from the input when the input
   * was a page and the feed was resolved via `<link rel="alternate">`
   * autodiscovery.
   */
  resolvedUrl: string;
};
