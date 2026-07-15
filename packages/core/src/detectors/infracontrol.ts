// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Infracontrol Online (felanmälan) detector. The form is an iframe
 * hosted by `infracontrol.com`; munis embed it directly or behind a
 * `felanmalan.<domain>` host that redirects.
 */
import type { Detector } from "./types";

const detector: Detector = {
  id: "infracontrol",
  name: "Infracontrol Online (felanmälan)",
  description: "Citizen fault-reporting platform — SPA, generic crawler misses it.",
  detect({ $, url, finalUrl }) {
    const evidence: string[] = [];
    const effectiveUrl = (finalUrl ?? url).toLowerCase();
    if (effectiveUrl.includes("infracontrol")) {
      evidence.push(`final URL contains infracontrol (${finalUrl ?? url})`);
    }
    let hits = 0;
    $("a[href], iframe[src], script[src], link[href]").each((_, el) => {
      const u = ($(el).attr("href") ?? $(el).attr("src") ?? "").toLowerCase();
      if (u.includes("infracontrol")) hits++;
    });
    if (hits > 0) evidence.push(`${hits} reference(s) to infracontrol in markup`);
    if (evidence.length === 0) return null;
    return { confidence: "high", evidence };
  },
};

export default detector;
