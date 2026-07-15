// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Netpublicator detector. The vendor's portal is hosted on
 * `web.netpublicator.com`; munis link to it from a "möten och
 * protokoll" page rather than running it on their own subdomain.
 *
 * Looks for `netpublicator.com` in either the final URL (a `moten.<muni>`
 * subdomain that redirected away) or in any link / iframe on the page.
 */
import type { Detector } from "./types";

const detector: Detector = {
  id: "netpublicator",
  name: "Netpublicator (council meetings)",
  description: "Public agenda + protocol portal for KS/KF/nämnd meetings.",
  detect({ $, url, finalUrl }) {
    const evidence: string[] = [];

    const effectiveUrl = (finalUrl ?? url).toLowerCase();
    if (effectiveUrl.includes("netpublicator.com")) {
      evidence.push(`final URL on netpublicator.com (${finalUrl ?? url})`);
    }

    let linkHits = 0;
    $("a[href], iframe[src]").each((_, el) => {
      const u = ($(el).attr("href") ?? $(el).attr("src") ?? "").toLowerCase();
      if (u.includes("netpublicator.com")) linkHits++;
    });
    if (linkHits > 0) evidence.push(`${linkHits} link(s) or iframe(s) to netpublicator.com`);

    if (evidence.length === 0) return null;
    return { confidence: "high", evidence };
  },
};

export default detector;
