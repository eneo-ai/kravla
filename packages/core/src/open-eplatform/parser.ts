// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure HTML → e-service record parser for Open ePlatform portals. No I/O —
 * the caller fetches the HTML and feeds it in, which keeps the parser unit-
 * testable against captured fixture pages.
 *
 * Open ePlatform's catalog page renders all categories + services in one
 * document. Each category is a `<section id="flowtype_…">` with an inner
 * `<ul>` of `<li data-flowid="…">` service rows. The icons we look at
 * (`icon-person`, `icon-launch`) come from the platform's own stylesheet —
 * they're stable across municipalities because every Nordic Peak deployment
 * uses the same theme assets.
 */
import * as cheerio from "cheerio";

export type ParsedEservice = {
  flowId: string | null;
  overviewId: string | null;
  name: string;
  description: string;
  category: string | null;
  categoryFlowTypeId: string | null;
  requiresLogin: boolean;
  isExternal: boolean;
  /** Relative href as it appears in the portal HTML. Caller resolves to absolute. */
  servicePath: string | null;
};

export type PortalProbe = {
  isOpenEplatform: boolean;
  /** Free-text hints from `<meta>` tags — surfaced in error messages. */
  detectedHints: string[];
};

const PROBE_NEEDLES = ["open eplatform", "nordic peak"];

/**
 * Heuristic check for "is this URL serving an Open ePlatform portal?". Looks
 * at `<meta name="description"|"keywords">` (where Nordic Peak's default
 * theme leaves a fingerprint) and the body-level marker classes used by the
 * portal's stock template. We don't want the runner to silently produce 0
 * services if the operator pasted the wrong URL — better to refuse the
 * crawl with a clear "this doesn't look like an Open ePlatform portal".
 */
export function probePortal(html: string): PortalProbe {
  const $ = cheerio.load(html);
  const hints: string[] = [];
  $('meta[name="description"], meta[name="keywords"]').each((_, el) => {
    const content = ($(el).attr("content") ?? "").trim();
    if (content) hints.push(content);
  });

  const haystack = hints.join(" \n ").toLowerCase();
  const metaHit = PROBE_NEEDLES.some((needle) => haystack.includes(needle));
  // Even when the meta tags are stripped by an aggressive theme, the
  // flowtype_ section ids are emitted by Open ePlatform's own renderer
  // and are a strong structural signal.
  const structuralHit = $('section[id^="flowtype_"]').length > 0;

  return { isOpenEplatform: metaHit || structuralHit, detectedHints: hints };
}

export function parseEservices(html: string): ParsedEservice[] {
  const $ = cheerio.load(html);
  const out: ParsedEservice[] = [];

  $('section[id^="flowtype_"]').each((_, section) => {
    const $section = $(section);
    const categoryFlowTypeId = ($section.attr("data-flowtypeid") ?? "").trim() || null;

    // Find the category heading. Real Open ePlatform portals wrap it in a
    // `<div class="heading-wrapper">`, so `.children("h2")` misses it. We
    // walk by:
    //   1. `aria-labelledby` → the h2 carrying that id (most semantic).
    //   2. fallback: first `h2[id$="_section_title"]` (Sundsvall et al.).
    //   3. fallback: first descendant `<h2>` that isn't inside a `<li>`
    //      (service names live in `<li><h2>`).
    let $categoryHeading = $section.find('h2[id$="_section_title"]').first();
    const labelledBy = $section.attr("aria-labelledby");
    if (!$categoryHeading.length && labelledBy) {
      // Use attribute selector rather than `#id` so id values with special
      // characters don't break the selector.
      $categoryHeading = $section.find(`h2[id="${labelledBy}"]`).first();
    }
    if (!$categoryHeading.length) {
      $categoryHeading = $section
        .find("h2")
        .filter((_, el) => $(el).closest("li").length === 0)
        .first();
    }

    let category: string | null = null;
    if ($categoryHeading.length) {
      const clone = $categoryHeading.clone();
      // Drop the service-count span and any trailing interactive controls
      // (clear-filter button, etc.) so we get just the human-readable label.
      clone.find("span.count, a, button, i").remove();
      // `[\s ]` to include the non-breaking space Open ePlatform
      // emits between the label and the `(N)` count.
      const text = clone
        .text()
        .replace(/[\s ]*\(\d*\)[\s ]*$/, "")
        .replace(/[\s ]+/g, " ")
        .trim();
      category = text || null;
    }

    $section.find("li[data-flowid]").each((_idx, li) => {
      const $li = $(li);
      const flowId = ($li.attr("data-flowid") ?? "").trim() || null;

      const nameRaw = $li.find("h2").first().text().trim();
      if (!nameRaw) return;

      const $anchor = $li.find("a[href]").first();
      const href = ($anchor.attr("href") ?? "").trim() || null;

      let overviewId: string | null = null;
      if (href) {
        const m = href.match(/\/overview\/(\d+)/);
        if (m) overviewId = m[1] ?? null;
      }

      const description = $li.find("div.description p").first().text().trim();
      const requiresLogin = $li.find("i.icon-person").length > 0;
      const isExternal = $li.find("i.icon-launch").length > 0;

      out.push({
        flowId,
        overviewId,
        name: nameRaw,
        description,
        category,
        categoryFlowTypeId,
        requiresLogin,
        isExternal,
        servicePath: href,
      });
    });
  });

  return out;
}
