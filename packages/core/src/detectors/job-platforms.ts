// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recruitment ATS family detector — Varbi, ReachMee, Visma Recruit,
 * Offentliga Jobb, Teamtailor, EasyCruit. Their hosts get linked from
 * the muni's "lediga jobb" / careers page.
 *
 * `metadata.vendors` carries which vendor(s) matched on a given page,
 * so a roll-up can split per-platform without re-parsing evidence.
 */
import type { Detector } from "./types";

const VENDORS: { id: string; hosts: string[] }[] = [
  { id: "varbi", hosts: ["varbi.com"] },
  { id: "reachmee", hosts: ["reachmee.com", "mynetworkglobal.com"] },
  { id: "visma-recruit", hosts: ["vismarecruit.se", "visma.recruit.com"] },
  { id: "offentligajobb", hosts: ["offentligajobb.se"] },
  { id: "teamtailor", hosts: ["teamtailor.com"] },
  { id: "easycruit", hosts: ["easycruit.com"] },
];

const detector: Detector = {
  id: "ats-recruitment",
  name: "Recruitment ATS (Varbi / ReachMee / Visma / Offentliga Jobb)",
  description: "Job-listing platforms linked from the muni's careers page.",
  detect({ $ }) {
    const matched = new Map<string, number>();
    $("a[href], iframe[src]").each((_, el) => {
      const u = ($(el).attr("href") ?? $(el).attr("src") ?? "").toLowerCase();
      for (const v of VENDORS) {
        if (v.hosts.some((h) => u.includes(h))) {
          matched.set(v.id, (matched.get(v.id) ?? 0) + 1);
        }
      }
    });
    if (matched.size === 0) return null;
    return {
      confidence: "high",
      evidence: [...matched.entries()].map(([id, n]) => `${id}: ${n} link(s)`),
      metadata: { vendors: [...matched.keys()] },
    };
  },
};

export default detector;
