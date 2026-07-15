// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HTML → Markdown extraction for crawled pages.
 *
 * Strategy:
 *   1. Run Mozilla Readability (Firefox's reader-mode algorithm) — drops
 *      nav, footer, sidebars, cookie banners, "läs mer" boilerplate, etc.
 *      Returns the "main article" subtree as cleaned HTML.
 *   2. If Readability returns ≥200 chars of textContent, convert that
 *      subtree to Markdown via Turndown. Preserves headings, lists,
 *      links (anchor text + URL), code blocks.
 *   3. Otherwise fall back: strip noise tags (script/style/svg/iframe/nav/
 *      footer/aside) from the body, turndown the rest. Catches pages
 *      Readability bails on (listing pages, sitemaps, very short pages).
 *
 * Why Markdown not plain text:
 *   - Heading levels give natural chunk boundaries for the splitter.
 *   - Code blocks are explicitly delimited (triple-backtick), so they're
 *     embedded in context rather than as orphan token soup.
 *   - Link anchor text + URL are both preserved, which matters for RAG
 *     ("Visit [Stadshuset](/about)" vs bare "Visit Stadshuset").
 *
 * DOM layer: Readability runs on linkedom, not jsdom. Same algorithm, same
 * output (verified line-identical across the extraction-fidelity corpus —
 * see scripts/extraction-fidelity), at ~6x less CPU and memory per page;
 * jsdom built a full browser-grade DOM per crawled page and dominated the
 * crawl worker's footprint on multi-MB pages.
 */
import * as cheerio from "cheerio";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

// Exported so eval tooling (scripts/extraction-fidelity) can run alternative
// extractors through the exact production Turndown config without mirroring it.
export const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
});

// Belt-and-braces: even if these snuck through Readability's main-content
// pass, ensure they never reach the chunker. `svg` is intentionally not in
// this list — it's an SVG-namespace element, not HTMLElementTagNameMap, so
// Turndown's typed `.remove()` rejects it. The cheerio fallback strips it
// explicitly, and Readability prunes presentational SVG content as part of
// its main-content pass.
turndown.remove(["script", "style", "noscript", "iframe"]);

export type ExtractedContent = {
  title: string | null;
  markdown: string;
  /** Whether Readability's main-content extraction succeeded. */
  readabilityUsed: boolean;
};

/**
 * Minimum text length Readability's output must have for us to trust it.
 * Below this, fallback to whole-body extraction — Readability heuristics
 * tend to over-prune on short pages, listing pages, sitemaps, etc.
 * Exported for the extraction-fidelity harness (see `turndown` above).
 */
export const READABILITY_MIN_CHARS = 200;

/**
 * Parse HTML with linkedom such that URL resolution matches what jsdom's
 * `{ url }` option provided: `location` gives the document a base for
 * resolving relative hrefs (Node.baseURI falls back to
 * defaultView.location.href), and `documentURI` makes Readability's
 * hash-anchor guard (`baseURI == documentURI`) hold so in-page `#anchor`
 * links stay relative instead of being absolutized.
 *
 * Exported for the extraction-fidelity harness so alternative extractors
 * are fed an identically-configured document.
 */
export function parseHtmlDocument(html: string, url: string): Document {
  const { document } = parseHTML(html, { location: new URL(url) });
  (document as { documentURI?: string }).documentURI = url;
  return document as unknown as Document;
}

/**
 * Resolve a possibly-relative URL to absolute against the page URL. Leaves
 * `data:` URIs and already-absolute URLs untouched; returns null for values
 * that can't be parsed (the caller then keeps the original).
 */
function toAbsoluteUrl(src: string | undefined, pageUrl: string): string | null {
  if (!src || src.startsWith("data:")) return null;
  try {
    return new URL(src, pageUrl).href;
  } catch {
    return null;
  }
}

/**
 * Fallback path: strip noise tags, markdown the rest. Used when Readability
 * bails or returns too little text. Exported (like `turndown` above) so the
 * extraction-fidelity harness can reuse the exact production fallback.
 */
export function cheerioFallback(html: string, url: string): ExtractedContent {
  const $ = cheerio.load(html);
  // Grab title before stripping <head>; we don't strip head itself, but
  // some sites put scripts in head — just being explicit.
  const title = $("title").first().text().trim() || null;
  $("script, style, noscript, svg, iframe, link, meta, nav, footer, aside, header").remove();
  // Absolutize image URLs so crawled content embeds full image URLs (we keep
  // the origin's URL — no download). The Readability path already does this
  // via its own relative-URI fixup; cheerio doesn't, so do it by hand.
  $("img[src]").each((_, el) => {
    const abs = toAbsoluteUrl($(el).attr("src"), url);
    if (abs) $(el).attr("src", abs);
  });
  const bodyHtml = $("body").html() ?? "";
  return {
    title,
    markdown: turndown.turndown(bodyHtml).trim(),
    readabilityUsed: false,
  };
}

export function extractContent(html: string, url: string): ExtractedContent {
  // ---- Readability path ---------------------------------------------------
  try {
    // Readability mutates the document, but the fallback below re-parses the
    // original `html` string, so no defensive clone is needed.
    const reader = new Readability(parseHtmlDocument(html, url));
    const article = reader.parse();
    const text = article?.textContent?.trim() ?? "";
    if (article && article.content && text.length >= READABILITY_MIN_CHARS) {
      return {
        title: article.title?.trim() || null,
        markdown: turndown.turndown(article.content).trim(),
        readabilityUsed: true,
      };
    }
  } catch {
    // Readability/linkedom can throw on extremely malformed input. Fall through.
  }

  return cheerioFallback(html, url);
}
