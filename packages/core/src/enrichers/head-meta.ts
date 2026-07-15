// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extracts structured signal from the page's `<head>` — the slice
 * Readability throws away. Covers OpenGraph + `article:*` (well-populated
 * on Sitevision news articles + WordPress), Dublin Core `dcterms.*`
 * (Sitevision's archival markers, ~83% of SV pages in the recon),
 * EpiServer's `<meta name="pageid">`, plus canonical link and robots.
 *
 * Empty fields are dropped — the returned metadata object only carries
 * keys the page actually had. Returns `null` when nothing useful was
 * present so the runner can skip a downstream merge.
 */
import type { Enricher, Enrichment } from "./types";

const OG_KEYS = ["title", "description", "image", "type", "url", "site_name", "locale"] as const;
const ARTICLE_KEYS = ["section"] as const;

const enricher: Enricher = {
  id: "head-meta",
  enrich({ $, url }) {
    const out: Record<string, unknown> = {};

    const canonical = ($('link[rel="canonical"]').attr("href") ?? "").trim();
    if (canonical) {
      // Resolve relative — Sitevision sometimes emits site-relative canonicals.
      try {
        out.canonicalUrl = new URL(canonical, url).toString();
      } catch {
        // Invalid canonical — keep the raw value rather than dropping silently;
        // a search-time consumer can decide what to do with it.
        out.canonicalUrl = canonical;
      }
    }

    const og: Record<string, string> = {};
    for (const key of OG_KEYS) {
      const v = ($(`meta[property="og:${key}"]`).attr("content") ?? "").trim();
      if (v) og[normaliseKey(key)] = v;
    }
    if (Object.keys(og).length > 0) out.og = og;

    const article: Record<string, unknown> = {};
    const published = ($('meta[property="article:published_time"]').attr("content") ?? "").trim();
    if (published) article.publishedAt = published;
    const modified = (
      $('meta[property="article:modified_time"]').attr("content") ??
      $('meta[property="og:updated_time"]').attr("content") ??
      ""
    ).trim();
    if (modified) article.modifiedAt = modified;
    for (const key of ARTICLE_KEYS) {
      const v = ($(`meta[property="article:${key}"]`).attr("content") ?? "").trim();
      if (v) article[key] = v;
    }
    const tags: string[] = [];
    $('meta[property="article:tag"]').each((_, el) => {
      const v = ($(el).attr("content") ?? "").trim();
      if (v) tags.push(v);
    });
    if (tags.length > 0) article.tags = tags;
    if (Object.keys(article).length > 0) out.article = article;

    const dcterms: Record<string, string> = {};
    $('meta[name^="dcterms."], meta[name^="DCTERMS."], meta[name^="DC."]').each((_, el) => {
      const name = ($(el).attr("name") ?? "").toLowerCase();
      const v = ($(el).attr("content") ?? "").trim();
      if (!v) return;
      // Normalise "dcterms.identifier" → "identifier"; "dc.creator" → "creator".
      const sub = name.replace(/^d(c|cterms)\./, "");
      if (sub) dcterms[sub] = v;
    });
    if (Object.keys(dcterms).length > 0) out.dcterms = dcterms;

    // EpiServer's stable page identifier — single field, single source.
    const pageId = ($('meta[name="pageid"]').attr("content") ?? "").trim();
    if (pageId) out.pageId = pageId;

    const keywordsRaw = ($('meta[name="keywords"]').attr("content") ?? "").trim();
    if (keywordsRaw) {
      const keywords = keywordsRaw
        .split(/[,;]\s*/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      if (keywords.length > 0) out.keywords = keywords;
    }

    const robots = ($('meta[name="robots"]').attr("content") ?? "").trim();
    if (robots) out.robots = robots.toLowerCase();

    if (Object.keys(out).length === 0) return null;
    const enrichment: Enrichment = { metadata: out, extraChunks: [] };
    return enrichment;
  },
};

/** Snake_case OG keys → camelCase output (`site_name` → `siteName`). */
function normaliseKey(k: string): string {
  return k.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
}

export default enricher;
