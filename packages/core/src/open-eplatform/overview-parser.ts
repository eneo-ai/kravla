// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure HTML → overview-page record parser. Mirror of `parser.ts` for the
 * service catalog: the caller fetches the HTML and feeds it in.
 *
 * Selectors anchor on Nordic Peak's stock template class/attribute names
 * (`.flow-overview`, `.description.textcontent`, `.aside-inside.start-flow-panel`,
 * `.service-navigator-wrap.summary`, `#simplebox-owner`, `#simplebox-contact`,
 * `.about-flow`, `data-step="…"`) which are stable across municipal portals —
 * any Swedish label-matching is avoided. Smaller portals (Hudiksvall et al.)
 * omit the GDPR `#simplebox-owner` panel entirely; this is treated as a
 * normal absence, not an error, and the corresponding field is null.
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { OpenEplatformOverview } from "./types";

export function parseOverview(html: string): OpenEplatformOverview {
  const $ = cheerio.load(html);
  const overviewLength = $(".flow-overview").length;
  // If the overview wrapper isn't there the page isn't a Nordic Peak
  // overview at all — return the empty shape so the caller can decide
  // whether to record this as a failure or just skip enrichment.
  if (overviewLength === 0) return emptyOverview();

  const flowStartUrl = extractFlowStartUrl($);
  const flowStartId = flowStartUrl ? parseFlowId(flowStartUrl) : null;

  return {
    flowStartUrl,
    flowStartId,
    metaDescription: extractMetaDescription($),
    descriptionText: extractDescriptionText($),
    requirements: extractRequirements($),
    steps: extractSteps($),
    relatedLinks: extractRelatedLinks($),
    contact: extractContact($),
    dataController: extractDataController($),
  };
}

function emptyOverview(): OpenEplatformOverview {
  return {
    flowStartUrl: null,
    flowStartId: null,
    metaDescription: null,
    descriptionText: null,
    requirements: [],
    steps: [],
    relatedLinks: [],
    contact: null,
    dataController: null,
  };
}

function extractFlowStartUrl($: CheerioAPI): string | null {
  const href = $('.flow-overview .aside-inside.start-flow-panel a[href*="/flow/"]')
    .first()
    .attr("href");
  const trimmed = href?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseFlowId(flowUrl: string): number | null {
  const m = /\/flow\/(\d+)/.exec(flowUrl);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function extractMetaDescription($: CheerioAPI): string | null {
  const raw = $('meta[name="description"]').attr("content");
  if (!raw) return null;
  // Nordic Peak emits the meta-content with raw HTML entities
  // (`H&auml;r kan du…`). Cheerio's `.attr()` doesn't decode them, but
  // round-tripping through a sacrificial element's `.html()` → `.text()`
  // does — no need to pull in `entities` directly.
  const decoded = $("<span>").html(raw).text().trim();
  return decoded.length > 0 ? decoded : null;
}

function extractDescriptionText($: CheerioAPI): string | null {
  // `.description.textcontent` is the main prose container. Clone before
  // stripping so we don't mutate `$`'s tree — Hudiksvall renders the
  // contact `.about-flow` block as a child of the description and we don't
  // want it duplicated in the long-form text.
  const $clone = $(".flow-overview .description.textcontent").first().clone();
  if ($clone.length === 0) return null;
  $clone.find(".about-flow, .about-flow-extension, .start-flow-panel").remove();
  // Nordic Peak's template uses `&nbsp;` inside inline `<strong>` section
  // labels (e.g. "Ansök eller anmäl&nbsp;via e-tjänst"). Normalise to ASCII
  // space before whitespace collapsing so consumers don't have to know
  // about the difference.
  const text = $clone
    .text()
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

function extractRequirements($: CheerioAPI): string[] {
  const items: string[] = [];
  $(".flow-overview .aside-inside.start-flow-panel ul.checklist > li").each((_, li) => {
    const text = condenseWhitespace($(li).text());
    if (text) items.push(text);
  });
  return items;
}

function extractSteps($: CheerioAPI): string[] {
  const steps: { idx: number; text: string }[] = [];
  $(".flow-overview .service-navigator-wrap.summary ol.service-navigator [data-step]").each(
    (_, el) => {
      const $el = $(el);
      const idx = Number.parseInt($el.attr("data-step") ?? "", 10);
      const text = condenseWhitespace($el.text());
      if (text) steps.push({ idx: Number.isFinite(idx) ? idx : steps.length + 1, text });
    },
  );
  // Sort by `data-step` so the template's declared order survives whatever
  // order the DOM emits.
  steps.sort((a, b) => a.idx - b.idx);
  return steps.map((s) => s.text);
}

function extractRelatedLinks($: CheerioAPI): { href: string; text: string }[] {
  const $desc = $(".flow-overview .description.textcontent").first();
  if ($desc.length === 0) return [];
  const seen = new Set<string>();
  const out: { href: string; text: string }[] = [];
  $desc.find("a[href]").each((_, a) => {
    const $a = $(a);
    const href = ($a.attr("href") ?? "").trim();
    if (!href) return;
    // Contact link types are surfaced through `contact` / `dataController`;
    // dropping them here keeps `relatedLinks` focused on outbound resources.
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    const text = condenseWhitespace($a.text());
    if (!text) return;
    const key = `${href}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ href, text });
  });
  return out;
}

function extractContact(
  $: CheerioAPI,
): { department: string | null; email: string | null; phone: string | null } | null {
  // Sundsvall pattern — collapsible (`#simplebox-contact`). Hudiksvall —
  // inline (`.about-flow`).
  const $box = $(".flow-overview").find("#simplebox-contact, .about-flow").first();
  if ($box.length === 0) return null;

  const email = firstHrefValue($, $box, 'a[href^="mailto:"]', "mailto:");
  const phone = firstHrefValue($, $box, 'a[href^="tel:"]', "tel:");

  // Department label is the text that isn't a link. Both templates render
  // it as the first non-empty text node (`<p>Dept<br>email<br>phone</p>`
  // or `<h2>Frågor…</h2>Dept<br>email`). Clone, strip anchors + the section
  // heading, then take whatever text survives.
  const $clone = $box.clone();
  $clone.find("a, button, h1, h2, h3").remove();
  const department = condenseWhitespace($clone.text()) || null;

  if (!email && !phone && !department) return null;
  return { department, email, phone };
}

function extractDataController(
  $: CheerioAPI,
): { sections: { heading: string; items: string[] }[]; email: string | null } | null {
  const $panel = $(".flow-overview #simplebox-owner").first();
  if ($panel.length === 0) return null;

  // Walk siblings inside the panel: each <h3> opens a new section, and the
  // following <p>/<ul> nodes are the items. No Swedish-string lookups —
  // the heading text becomes the section label as-is.
  const sections: { heading: string; items: string[] }[] = [];
  let current: { heading: string; items: string[] } | null = null;
  $panel.children().each((_, child) => {
    const $child = $(child);
    const tag = $child.prop("tagName")?.toLowerCase();
    if (tag === "h3") {
      if (current) sections.push(current);
      current = { heading: condenseWhitespace($child.text()), items: [] };
      return;
    }
    if (!current) return;
    if (tag === "ul" || tag === "ol") {
      $child.children("li").each((_idx, li) => {
        const text = condenseWhitespace($(li).text());
        if (text) current?.items.push(text);
      });
      return;
    }
    if (tag === "p") {
      const text = condenseWhitespace($child.text());
      if (text) current.items.push(text);
      return;
    }
  });
  if (current) sections.push(current);

  const email = firstHrefValue($, $panel, 'a[href^="mailto:"]', "mailto:");
  return { sections, email };
}

function firstHrefValue(
  _$: CheerioAPI,
  $scope: ReturnType<CheerioAPI>,
  selector: string,
  schemePrefix: string,
): string | null {
  const href = $scope.find(selector).first().attr("href");
  if (!href) return null;
  const value = href.startsWith(schemePrefix) ? href.slice(schemePrefix.length) : href;
  const decoded = value.trim();
  return decoded.length > 0 ? decoded : null;
}

function condenseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
