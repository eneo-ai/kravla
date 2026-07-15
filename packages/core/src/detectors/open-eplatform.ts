// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Open ePlatform (Nordic Peak) detector. Reuses the runtime probe
 * function — `probePortal` looks at meta hints and `section[id^=flowtype_]`
 * presence, the same fingerprints the specialised eplatform runner gates on.
 *
 * A high-confidence detection on a page reached by the generic crawler
 * usually means the page is actually the catalog root and would be better
 * served by the eplatform runner — surfacing this is the point: the
 * operator should re-classify the source.
 */
import { probePortal } from "../open-eplatform/parser";
import type { Detector } from "./types";

const detector: Detector = {
  id: "open-eplatform",
  name: "Open ePlatform (Nordic Peak)",
  description: "Self-service portal — has a dedicated specialised crawler.",
  detect({ $ }) {
    const html = $.html();
    const { isOpenEplatform, detectedHints } = probePortal(html);
    if (!isOpenEplatform) return null;
    return {
      confidence: "high",
      evidence: [
        "matched probePortal() — `section[id^=flowtype_]` and/or meta hint",
        ...(detectedHints.length ? [`meta hints: ${detectedHints.slice(0, 2).join(" | ")}`] : []),
      ],
    };
  },
};

export default detector;
