// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public library platform detector. Most Swedish municipal libraries
 * run Axiell Arena / Quria / Bibblix / Book-it. Catches references in
 * script, stylesheet, iframe, and link srcs — Axiell-fronted catalogs
 * serve a thin HTML shell from the muni's `bibliotek.*` host but pull
 * all their JS/CSS from `*.axiell.com`.
 */
import type { Detector } from "./types";

const VENDOR_FRAGMENTS = ["axiell.com", "arena-arena", "bibblix.se", "biblioteket.se", "bibsam"];

const detector: Detector = {
  id: "library-catalog",
  name: "Public library catalog (Axiell / Quria / Bibblix)",
  description: "Library catalog software linked from the muni main site.",
  detect({ $, url, finalUrl }) {
    const evidence: string[] = [];
    const effectiveUrl = (finalUrl ?? url).toLowerCase();
    for (const f of VENDOR_FRAGMENTS) {
      if (effectiveUrl.includes(f)) evidence.push(`final URL contains ${f}`);
    }
    const hits = new Map<string, number>();
    $("a[href], iframe[src], script[src], link[href]").each((_, el) => {
      const u = ($(el).attr("href") ?? $(el).attr("src") ?? "").toLowerCase();
      for (const f of VENDOR_FRAGMENTS) {
        if (u.includes(f)) hits.set(f, (hits.get(f) ?? 0) + 1);
      }
    });
    for (const [f, n] of hits) evidence.push(`${n} markup reference(s) containing ${f}`);
    if (evidence.length === 0) return null;
    return { confidence: "high", evidence };
  },
};

export default detector;
