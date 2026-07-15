// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detector registry + runner. Called from `crawl-runner.ts`
 * `requestHandler` on every successfully fetched page so the platforms
 * a page touches get recorded in `source_document.metadata.detectedPlatforms`.
 *
 * The runner:
 *   - Iterates every registered detector (order is irrelevant — a page
 *     can match many at once; multi-match is the norm, not the
 *     exception).
 *   - Swallows individual detector exceptions so a malformed page
 *     can't sink the others. Logged via the caller's pino instance
 *     when one fires.
 *   - Caps matches per page at `MAX_MATCHES` — a page that somehow
 *     trips every detector is suspicious and we don't want to spam
 *     the document metadata.
 *
 * Adding a new detector: drop a `.ts` next to this one that
 * default-exports a `Detector`, then add it to `DETECTORS`. Order
 * inside the array doesn't matter — the persisted set is keyed by detector id
 * inside each source document.
 */
import type { Logger } from "../logger";
import openEplatform from "./open-eplatform";
import sitevision from "./sitevision";
import episerver from "./episerver";
import netpublicator from "./netpublicator";
import infracontrol from "./infracontrol";
import jobPlatforms from "./job-platforms";
import library from "./library";
import type { Detector, DetectorInput, DetectorMatch } from "./types";

export type { Detector, DetectorInput, DetectorMatch } from "./types";

// Shelved detectors (had near-zero findings across the SKL corpus):
//   - meetings-plus / OpenGov / Ciceron Meeting Plus — 0 of 290 munis.
//     None of the four vendor host strings (opengov.cloudapp.net,
//     opengov.se, meetingsplus.se, ciceronmeetingplus) appeared
//     anywhere. MeetingPlus deployments DO exist (Hylte's
//     `meetings.hylte.se` surfaced in the meta-detector report) under
//     a different fingerprint — write a fresh detector against that
//     fingerprint rather than resurrecting the vendor-string approach.
//   - facility-booking (Interbook GO / Bokningar.se / RBOK) — 1 of 290
//     munis. The single hit isn't enough signal to maintain a detector;
//     bring it back when there's an actual consumer for the data.
export const DETECTORS: Detector[] = [
  openEplatform,
  sitevision,
  episerver,
  netpublicator,
  infracontrol,
  jobPlatforms,
  library,
];

const MAX_MATCHES = 20;

export function runDetectors(input: DetectorInput, log?: Logger): DetectorMatch[] {
  const out: DetectorMatch[] = [];
  for (const detector of DETECTORS) {
    if (out.length >= MAX_MATCHES) break;
    let match: ReturnType<Detector["detect"]>;
    try {
      match = detector.detect(input);
    } catch (err) {
      log?.warn(
        { detector: detector.id, url: input.url, err: err instanceof Error ? err.message : err },
        "detector threw — skipping",
      );
      continue;
    }
    if (!match) continue;
    out.push({
      detectorId: detector.id,
      detectorName: detector.name,
      confidence: match.confidence,
      evidence: match.evidence,
      ...(match.metadata ? { metadata: match.metadata } : {}),
    });
  }
  return out;
}
