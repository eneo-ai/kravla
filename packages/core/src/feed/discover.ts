// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RSS/Atom autodiscovery — find the feed a page advertises via the standard
 * `<link rel="alternate" type="application/rss+xml">` (or `atom+xml`) head tag.
 *
 * Lets a feed source point at a normal page URL (e.g. an organisation's root)
 * and have the actual feed resolved at fetch time, instead of pinning an
 * opaque/brittle feed URL. SiteVision sites (e.g. SKR) expose their feed only
 * this way.
 */
import * as cheerio from "cheerio";

/**
 * Return the first RSS/Atom feed URL advertised in the HTML's `<head>`,
 * resolved absolute against `baseUrl`, or null when the page advertises none.
 */
export function extractFeedLink(html: string, baseUrl: string): string | null {
  const $ = cheerio.load(html);
  const link = $(
    'link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]',
  )
    .first()
    .attr("href");
  if (!link) return null;
  try {
    return new URL(link, baseUrl).href;
  } catch {
    return null;
  }
}

/** True when the response is an HTML page rather than a feed document. */
export function looksLikeHtml(contentType: string | null, body: string): boolean {
  const ct = contentType?.toLowerCase() ?? "";
  if (ct.includes("html")) return true;
  if (ct.includes("xml") || ct.includes("rss") || ct.includes("atom")) return false;
  return /^\s*(?:<!doctype html|<html[\s>])/i.test(body);
}
