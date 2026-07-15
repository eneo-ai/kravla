// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Enricher pipeline entry point. Runs all registered enrichers over the
 * same loaded cheerio instance and merges their output into a single
 * `Enrichment` the crawl runner can attach to its `CrawlPage`.
 *
 * Merge rules:
 *   - `metadata` is shallow-merged. Each enricher namespaces its output
 *     under its own top-level key (`og`, `article`, `jsonLd`,
 *     `sitevision`, …) so collisions don't happen by construction —
 *     anything more elaborate would just hide bugs.
 *   - `extraChunks` are concatenated, then deduped + capped.
 *
 * Hard caps so a maliciously-large JSON-LD blob or a 400-card contact
 * page can't blow up the jsonb column or the embedding budget:
 *   - At most `MAX_METADATA_BYTES` serialised metadata bytes.
 *   - At most `MAX_EXTRA_CHUNKS` extra chunks per page.
 *   - Each chunk capped at `MAX_CHUNK_CHARS`.
 *
 * Caller (`crawl-runner.ts`) treats a null/empty enrichment as "no
 * metadata to write" — the generic CrawlPage stays unchanged in that
 * case.
 */
import * as cheerio from "cheerio";
import type { Enricher, Enrichment } from "./types";
import headMeta from "./head-meta";
import jsonLd from "./json-ld";
import sitevisionPortlets from "./sitevision-portlets";
import timeElements from "./time-elements";

export const ENRICHERS: Enricher[] = [headMeta, jsonLd, sitevisionPortlets, timeElements];

const MAX_METADATA_BYTES = 16 * 1024;
const MAX_EXTRA_CHUNKS = 40;
const MAX_CHUNK_CHARS = 800;

export type RunEnrichersResult = {
  metadata: Record<string, unknown> | null;
  extraChunks: string[];
};

/**
 * The crawl runner already has a Cheerio instance ready from Crawlee's
 * `requestHandler`; pass it through so we don't re-parse. The `html`
 * overload exists for tests + standalone callers that only have a string.
 */
export function runEnrichers(input: {
  $?: cheerio.CheerioAPI;
  html?: string;
  url: string;
}): RunEnrichersResult {
  const $ = input.$ ?? (input.html != null ? cheerio.load(input.html) : null);
  if (!$) return { metadata: null, extraChunks: [] };

  const merged: Record<string, unknown> = {};
  const chunks: string[] = [];

  for (const enricher of ENRICHERS) {
    let result: Enrichment | null;
    try {
      result = enricher.enrich({ $, url: input.url });
    } catch {
      // An individual enricher throwing on weird input shouldn't sink
      // the others. Detection-by-input was the user-pluggable surface
      // earlier; here every enricher is trusted code but we still keep
      // the run robust against unexpected DOM shapes.
      result = null;
    }
    if (!result) continue;
    for (const [k, v] of Object.entries(result.metadata)) {
      if (v == null) continue;
      merged[k] = v;
    }
    chunks.push(...result.extraChunks);
  }

  const cappedChunks = capExtraChunks(chunks);
  const cappedMetadata = capMetadata(merged);

  return {
    metadata: cappedMetadata && Object.keys(cappedMetadata).length > 0 ? cappedMetadata : null,
    extraChunks: cappedChunks,
  };
}

function capExtraChunks(chunks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of chunks) {
    if (out.length >= MAX_EXTRA_CHUNKS) break;
    const trimmed = raw.trim().slice(0, MAX_CHUNK_CHARS);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * If the serialised metadata exceeds the byte cap, drop the highest-byte
 * top-level keys first until we fit. We don't try to reach inside a key —
 * truncating a JSON-LD `events` array partway would yield a confusing
 * record; dropping the whole namespace is honest and rare in practice.
 */
function capMetadata(metadata: Record<string, unknown>): Record<string, unknown> | null {
  if (Object.keys(metadata).length === 0) return null;
  let serialised = JSON.stringify(metadata);
  if (serialised.length <= MAX_METADATA_BYTES) return metadata;
  const trimmed = { ...metadata };
  const sized = Object.entries(trimmed)
    .map(([k, v]) => [k, JSON.stringify(v).length] as const)
    .sort((a, b) => b[1] - a[1]);
  for (const [k] of sized) {
    delete trimmed[k];
    serialised = JSON.stringify(trimmed);
    if (serialised.length <= MAX_METADATA_BYTES) break;
  }
  return Object.keys(trimmed).length > 0 ? trimmed : null;
}
