// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sitevision-specific enricher. Self-gates on the presence of any
 * `sv-*-portlet` class — pages without one no-op immediately so we
 * don't pay the DOM walk on non-Sitevision content.
 *
 * What we extract (per the recon — markup that genuinely repeats):
 *   - `sv-related-portlet` → `sitevision.relatedUrls[]` from the inner
 *     anchors. Useful for "show related" UX and as a graph signal.
 *   - `sv-toc-portlet` → `sitevision.tocSections[]` with title + anchor.
 *   - `sv-eventcalendar-portlet` → `sitevision.events[]` (best-effort —
 *     calendar markup varies by deployment, parse what we can).
 *   - Contact cards: matches both the legacy `sv-contact2-portlet`
 *     selector AND the newer `<div class="contact">` Sitevision-app
 *     markup observed in the recon (Arboga et al.). Each card → one
 *     contact extraChunk.
 *
 * NOT extracted (confirmed misleading or absent in the recon):
 *   - `sv-faq-portlet` doesn't exist. FAQs are implemented ad-hoc.
 *   - `sv-archive-portlet` is a *widget* (recent-news sidebar) embedded
 *     into the global layout on most Sitevision sites, not a marker of
 *     "this page is an archive listing". Tried it; fired on every page.
 *     Dropped — no reliable way to distinguish widget-from-page-template.
 */
import type * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { Enricher, Enrichment } from "./types";

const enricher: Enricher = {
  id: "sitevision-portlets",
  enrich({ $, url }) {
    // Cheap gate: bail before touching the DOM if no Sitevision marker
    // is present. Matches sv-*-portlet OR the contact-app wrapper.
    const hasPortlet = $('[class*="sv-"][class*="-portlet"]').length > 0;
    const hasContactApp = $('div.contact[data-cid], [class^="sv-contact"]').length > 0;
    if (!hasPortlet && !hasContactApp) return null;

    const metadata: Record<string, unknown> = {};
    const extraChunks: string[] = [];

    const relatedUrls = extractRelatedUrls($, url);
    if (relatedUrls.length > 0) metadata.relatedUrls = relatedUrls;

    const tocSections = extractTocSections($);
    if (tocSections.length > 0) metadata.tocSections = tocSections;

    const events = extractEvents($);
    if (events.length > 0) metadata.events = events;

    const contactChunks = extractContactChunks($);
    extraChunks.push(...contactChunks);

    if (Object.keys(metadata).length === 0 && extraChunks.length === 0) return null;
    const enrichment: Enrichment = {
      metadata: Object.keys(metadata).length > 0 ? { sitevision: metadata } : {},
      extraChunks,
    };
    return enrichment;
  },
};

function extractRelatedUrls($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  $(".sv-related-portlet a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (seen.has(abs)) return;
      seen.add(abs);
      urls.push(abs);
    } catch {
      /* skip malformed hrefs */
    }
  });
  return urls;
}

function extractTocSections($: cheerio.CheerioAPI): { title: string; anchor: string }[] {
  const out: { title: string; anchor: string }[] = [];
  $(".sv-toc-portlet a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    const title = ($(el).text() ?? "").trim();
    if (!title || !href.startsWith("#")) return;
    out.push({ title, anchor: href });
  });
  return out;
}

function extractEvents($: cheerio.CheerioAPI): { name: string; date: string | null }[] {
  const out: { name: string; date: string | null }[] = [];
  $(".sv-eventcalendar-portlet [data-event-id], .sv-eventcalendar-portlet li.event").each(
    (_, el) => {
      const $el = $(el);
      const name = ($el.find("h3, h4, .event-title, .title").first().text() ?? "").trim();
      if (!name) return;
      const dateAttr =
        $el.find("time[datetime]").attr("datetime") ?? $el.attr("data-event-date") ?? null;
      out.push({ name, date: dateAttr });
    },
  );
  return out;
}

/**
 * Contact cards come in two shapes across deployments:
 *   1. The legacy portlet: `<section class="sv-contact2-portlet">` with
 *      a heading + child `<a href="tel:…">` and `<a href="mailto:…">`.
 *   2. The Sitevision contact app: `<div class="contact" data-cid="…">`
 *      with `.contact-title` (label) + `.contact-data` (value), e.g.
 *      "TELEFON" / "0589-870 00". Observed on Arboga in the recon.
 *
 * Both shapes get the same treatment — pull title/role + phone + email
 * into one line per card. We never emit empty chunks.
 */
function extractContactChunks($: cheerio.CheerioAPI): string[] {
  const chunks: string[] = [];
  const seen = new Set<string>();
  const emit = (chunk: string) => {
    const trimmed = chunk.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    chunks.push(trimmed);
  };

  $('[class^="sv-contact"], [class*=" sv-contact"], div.contact[data-cid], div.contact-card').each(
    (_, el) => {
      const $card = $(el);

      // Shape 2: title/data label-value pairs (Sitevision contact app).
      // `.contact-data` often packs multiline addresses inside `<br>` tags
      // (`Arboga kommun<br>Box 45<br>732 21 Arboga`). Cheerio's `.text()`
      // doesn't insert whitespace at `<br>` boundaries, so we'd get
      // "Arboga kommunBox 45732 21 Arboga". Normalise first.
      const title = collapseText($card.find(".contact-title").first());
      const data = collapseText($card.find(".contact-data").first());
      if (title && data) {
        emit(`Contact ${title.toLowerCase()}: ${data}`);
        return;
      }

      // Shape 1 + generic fallback: heading + tel/email anchors.
      const name =
        $card.find("h1, h2, h3, h4").first().text().trim() ||
        $card.find(".name, .person-name").first().text().trim();
      const role = $card.find(".role, .title, .jobtitle").first().text().trim();
      const tel = $card.find('a[href^="tel:"]').first().text().trim();
      const email = $card.find('a[href^="mailto:"]').first().text().trim();
      const parts: string[] = [];
      if (name) parts.push(name);
      if (role) parts.push(role);
      if (tel) parts.push(`tel ${tel}`);
      if (email) parts.push(`email ${email}`);
      if (parts.length > 0) emit(`Contact: ${parts.join(", ")}`);
    },
  );

  return chunks;
}

/**
 * Render a cheerio selection as collapsed text, treating `<br>` (and
 * common block-level tags) as whitespace boundaries so multiline content
 * doesn't end up word-glued. Used by the contact-card extractor where
 * `<p class="contact-data">A<br>B<br>C</p>` should read "A B C", not
 * "ABC".
 */
function collapseText($el: cheerio.Cheerio<AnyNode>): string {
  const html = $el.html() ?? "";
  if (!html) return $el.text().trim().replace(/\s+/g, " ");
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|td|th)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default enricher;
