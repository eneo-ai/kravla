// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-page enrichers run inside the generic Crawlee path to extract
 * structured signal that Readability's main-content pass throws away —
 * `<head>` metadata, schema.org JSON-LD, and known CMS portlets.
 *
 * Each enricher is a pure function over a loaded `cheerio.CheerioAPI` and
 * the page URL. They never fetch, never throw — on malformed input they
 * return `null` and the runner carries on. The shared `Enrichment` shape
 * has two slots:
 *
 *   - `metadata`: shallow-merged into `source_document.metadata` (jsonb). Namespaced
 *     under enricher-owned keys (`og`, `article`, `jsonLd`, `sitevision`,
 *     …) so two enrichers never collide on the same field.
 *   - `extraChunks`: short strings the indexer embeds alongside `rawText`
 *     for recall on short queries. One contact card → one extra chunk;
 *     one JSON-LD `FAQPage` Q/A → one extra chunk.
 *
 * Provider tagging note: this layer deliberately does NOT set
 * `metadata.provider`. Open ePlatform owns that key (the `search_eservices`
 * tool guards on it via `isOpenEplatformMetadata`); generic-enriched pages
 * stay untagged so the eservices tool keeps refusing them as expected.
 */
import type * as cheerio from "cheerio";

export type Enrichment = {
  metadata: Record<string, unknown>;
  extraChunks: string[];
};

export type Enricher = {
  id: string;
  enrich(input: EnricherInput): Enrichment | null;
};

export type EnricherInput = {
  /** Cheerio instance already loaded by the caller — no re-parse here. */
  $: cheerio.CheerioAPI;
  /** Final URL after redirects. Enrichers resolve relative hrefs against this. */
  url: string;
};
