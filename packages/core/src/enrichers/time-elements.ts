// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extracts publish/modify timestamps from visible `<time>` elements —
 * the byline dates ("Publicerad: …", "Senast uppdaterad: …") that pages
 * without `article:*` meta or JSON-LD still render in the DOM.
 *
 * Noise control, in order:
 *   1. Microdata wins outright: `time[itemprop="datePublished"]` /
 *      `time[itemprop="dateModified"]` are explicit publisher statements.
 *   2. Heuristic pass only over `<time datetime>` inside `<article>`,
 *      or anywhere when the page has ≤ 2 `<time>` elements total —
 *      event-listing pages with dozens of dates are skipped entirely.
 *   3. Candidates are classified by nearby context (element/parent
 *      class+id and a slice of the parent's text) against published/
 *      modified word lists, Swedish included. A single unclassified
 *      `<time>` inside `<article>` defaults to publishedAt — the common
 *      unlabeled byline.
 *
 * Values are emitted as raw strings under the `time` namespace;
 * `resolvePageDates` (page-dates.ts) owns validation and precedence.
 */
import type * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { Enricher, Enrichment } from "./types";
import { toIsoDate } from "../page-dates";

const MODIFIED_RE = /updated|modified|uppdaterad|ändrad|reviderad|granskad/i;
const PUBLISHED_RE = /published|posted|created|publicerad|skapad/i;

/** Context window of parent text used for classification. */
const CONTEXT_CHARS = 80;

const enricher: Enricher = {
  id: "time-elements",
  enrich({ $ }) {
    const out: { publishedAt?: string; modifiedAt?: string } = {};

    // 1. Microdata — datetime attr, falling back to element text per spec.
    const microPublished = timeValue($('time[itemprop="datePublished"]').first());
    if (microPublished) out.publishedAt = microPublished;
    const microModified = timeValue($('time[itemprop="dateModified"]').first());
    if (microModified) out.modifiedAt = microModified;

    if (!out.publishedAt || !out.modifiedAt) {
      const inArticle = $("article time[datetime]").toArray();
      const all = $("time[datetime]").toArray();
      const candidates = inArticle.length > 0 ? inArticle : all.length <= 2 ? all : [];

      const unclaimed: string[] = [];
      for (const el of candidates) {
        const value = ($(el).attr("datetime") ?? "").trim();
        if (!toIsoDate(value)) continue;
        const context = contextOf($, el);
        if (MODIFIED_RE.test(context)) {
          if (!out.modifiedAt) out.modifiedAt = value;
        } else if (PUBLISHED_RE.test(context)) {
          if (!out.publishedAt) out.publishedAt = value;
        } else {
          unclaimed.push(value);
        }
      }
      // The lone unlabeled byline date inside <article>.
      if (!out.publishedAt && inArticle.length > 0 && unclaimed.length === 1) {
        out.publishedAt = unclaimed[0];
      }
    }

    if (!out.publishedAt && !out.modifiedAt) return null;
    const enrichment: Enrichment = { metadata: { time: out }, extraChunks: [] };
    return enrichment;
  },
};

function timeValue(el: cheerio.Cheerio<AnyNode>): string | null {
  if (el.length === 0) return null;
  const value = (el.attr("datetime") ?? el.text()).trim();
  return toIsoDate(value) ? value : null;
}

function contextOf($: cheerio.CheerioAPI, el: AnyNode): string {
  const node = $(el);
  const parent = node.parent();
  return [
    node.attr("class") ?? "",
    node.attr("id") ?? "",
    parent.attr("class") ?? "",
    parent.attr("id") ?? "",
    parent.text().slice(0, CONTEXT_CHARS),
  ].join(" ");
}

export default enricher;
