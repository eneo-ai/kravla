// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sitevision detector. Three layers, scored most-to-least specific:
 *
 *   1. `<meta name="generator" content="Sitevision …">` — unambiguous.
 *   2. URL paths in the form `/4.<digits>.html` or asset paths under
 *      `/sitevision/`.
 *   3. CSS class prefixes (`sv-text-portlet`, `sv-image-portlet`, …).
 *      >=3 distinct portlet classes is almost certainly Sitevision.
 *
 * Layer 1 → high confidence. Layers 2/3 alone → low confidence.
 */
import type { Detector } from "./types";

const detector: Detector = {
  id: "sitevision",
  name: "Sitevision CMS",
  description: "Dominant Swedish municipal main-site CMS — structured portlets per page.",
  detect({ $, url, finalUrl, headers }) {
    const evidence: string[] = [];
    let high = false;

    const gen = ($('meta[name="generator"]').attr("content") ?? "").toLowerCase();
    if (gen.includes("sitevision")) {
      high = true;
      evidence.push(`meta[generator]=${gen}`);
    }

    const effectiveUrl = finalUrl ?? url;
    try {
      const path = new URL(effectiveUrl).pathname;
      if (/^\/\d+\.\d+(\.\d+)*(\.html)?$/i.test(path) || /^\/4(\.\d+){1,}/.test(path)) {
        evidence.push(`path matches Sitevision content-id pattern: ${path}`);
        high = true;
      }
    } catch {
      /* ignore malformed URLs */
    }

    const portletClasses = new Set<string>();
    $("[class]").each((_, el) => {
      const classes = ($(el).attr("class") ?? "").split(/\s+/);
      for (const c of classes) {
        if (/^sv-[a-z0-9-]+-portlet$/i.test(c)) portletClasses.add(c);
      }
    });
    if (portletClasses.size > 0) {
      evidence.push(
        `${portletClasses.size} distinct sv-*-portlet classes (e.g. ${[...portletClasses].slice(0, 3).join(", ")})`,
      );
      if (portletClasses.size >= 3) high = true;
    }

    if ($('script[src*="/sitevision/"], link[href*="/sitevision/"]').length > 0) {
      evidence.push("asset path /sitevision/ in script or stylesheet src");
      high = true;
    }

    const xPowered = (headers?.["x-powered-by"] ?? "").toLowerCase();
    if (xPowered.includes("sitevision")) {
      evidence.push(`x-powered-by: ${xPowered}`);
      high = true;
    }

    if (evidence.length === 0) return null;
    return { confidence: high ? "high" : "low", evidence };
  },
};

export default detector;
