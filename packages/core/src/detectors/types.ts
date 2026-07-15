// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runtime platform detectors. Same logic that powered the standalone
 * discovery script (`scripts/detect-municipal-services.ts`) — promoted
 * here so the regular crawl pipeline can call it on every page Crawlee
 * fetches.
 *
 * Why this lives in `src/lib/crawler/` now: the discovery script's
 * static-candidate-URL strategy (probe `https://www.<muni>` plus a few
 * subdomain guesses) under-counted every platform whose link sits on a
 * deeper page. The crawler already does the link traversal, so running
 * detectors inside `requestHandler` gives us natural coverage with no
 * URL guessing.
 *
 * Two callers share these detectors:
 *
 *   1. Runtime (this layer + the `crawl-runner` requestHandler hook).
 *      Each crawled page is fed through `runDetectors`, and matches
 *      land in `source_document.metadata.detectedPlatforms`.
 *
 *   2. The standalone discovery script in `scripts/detectors/`, which
 *      wraps each runtime detector with a `candidateUrls(muni)`
 *      function — used for pre-crawl discovery on munis we haven't
 *      onboarded yet (the SKL registry has 290; we crawl a handful).
 *
 * Detectors are pure: given a loaded cheerio API + URL + response
 * headers, they return a match or null. No fetching, no I/O, no
 * exceptions — `runDetectors` wraps each call in a try/catch but the
 * detector should still handle malformed input itself.
 */
import type * as cheerio from "cheerio";

export type DetectorInput = {
  /** URL the request was issued for. */
  url: string;
  /** Final URL after redirects, if different from `url`. */
  finalUrl?: string;
  /** Cheerio instance the caller already loaded; never re-parse. */
  $: cheerio.CheerioAPI;
  /**
   * Response headers (lowercase keys). Used for detectors that key off
   * `x-powered-by`, `server`, `set-cookie`, etc. Empty when the caller
   * doesn't have headers (e.g. the script's `Probe` always has them;
   * the crawl runtime currently passes through the Crawlee response
   * headers).
   */
  headers?: Record<string, string>;
};

export type DetectorMatch = {
  detectorId: string;
  detectorName: string;
  /** "high" = unambiguous fingerprint; "low" = circumstantial. */
  confidence: "high" | "low";
  /** Human-readable bullets — surface in operator UI / debug output. */
  evidence: string[];
  /** Structured per-detector extras (e.g. ATS detector lists matched vendors). */
  metadata?: Record<string, unknown>;
};

export type Detector = {
  id: string;
  name: string;
  description: string;
  detect(input: DetectorInput): Omit<DetectorMatch, "detectorId" | "detectorName"> | null;
};
