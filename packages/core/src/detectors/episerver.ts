// SPDX-License-Identifier: AGPL-3.0-only
/**
 * EpiServer / Optimizely (the rebrand) detector.
 *
 * Fingerprints:
 *   - `meta[generator]` literal "EPiServer" / "Optimizely" (high).
 *   - `/EPiServer/` or `/util/login.aspx` admin paths in markup (high).
 *   - `X-Powered-By: ASP.NET` alone (low — many ASP.NET sites).
 *   - `X-Powered-By: EpiServer` or Epi/.AspxAuth cookie (high).
 */
import type { Detector } from "./types";

const detector: Detector = {
  id: "episerver",
  name: "EpiServer / Optimizely",
  description: "Second-most-common municipal CMS — ASP.NET based.",
  detect({ $, headers }) {
    const evidence: string[] = [];
    let high = false;

    const gen = ($('meta[name="generator"]').attr("content") ?? "").toLowerCase();
    if (gen.includes("episerver") || gen.includes("optimizely")) {
      high = true;
      evidence.push(`meta[generator]=${gen}`);
    }

    const epiPath = $('script[src*="/EPiServer"], a[href*="/EPiServer"], link[href*="/EPiServer"]');
    if (epiPath.length > 0) {
      high = true;
      evidence.push(`found ${epiPath.length} reference(s) to /EPiServer/`);
    }
    if ($('a[href*="/util/login.aspx"]').length > 0) {
      evidence.push("link to /util/login.aspx (EpiServer-conventional admin path)");
      high = true;
    }

    const xPowered = (headers?.["x-powered-by"] ?? "").toLowerCase();
    if (xPowered.includes("episerver") || xPowered.includes("optimizely")) {
      high = true;
      evidence.push(`x-powered-by: ${xPowered}`);
    } else if (xPowered.includes("asp.net")) {
      evidence.push(`x-powered-by: ${xPowered}`);
      // Weak signal alone — keep low unless something above flipped `high`.
    }

    const setCookie = (headers?.["set-cookie"] ?? "").toLowerCase();
    if (setCookie.includes("epi") || setCookie.includes(".aspxauth")) {
      evidence.push("Epi/.AspxAuth cookie set");
      high = true;
    }

    if (evidence.length === 0) return null;
    return { confidence: high ? "high" : "low", evidence };
  },
};

export default detector;
