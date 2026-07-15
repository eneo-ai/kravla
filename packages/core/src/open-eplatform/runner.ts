// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Open ePlatform crawler entry point. Shape mirrors the generic
 * `runCrawl(input) → CrawlOutcome` in `../crawl-runner.ts` so
 * `processCrawlRun` can swap one for the other based on `crawl_source.crawlType`.
 *
 * Unlike the generic Crawlee path, Open ePlatform's catalog renders every
 * category + service in a single document, so this runner fetches exactly
 * one URL and emits one `CrawlPage` per discovered e-service. Each page
 * carries:
 *   - `rawText`: a markdown render of the service (chunked by the indexer).
 *   - `extraChunks`: 1–2 short per-field views (name+category, name alone)
 *     so the embedding model picks up short queries that match a single
 *     field rather than the whole concatenation.
 *   - `metadata`: the validated `OpenEplatformPageMetadata` record.
 *
 * Errors:
 *   - Non-2xx on the portal root → one `FailedUrl` with `http_error`.
 *   - Reachable but doesn't look like an Open ePlatform portal → one
 *     `FailedUrl` with `fetch_error` and a hint in `errorMessage`.
 *   - Per-service parse errors are skipped (logged), since the catalog
 *     is one big document and a broken `<li>` shouldn't sink the rest.
 */
import type { CrawlPage, FailedUrl } from "../crawl-runner";

/**
 * Dedicated outcome shape for the Open ePlatform runner. The generic
 * `CrawlOutcome` over in `../crawl-runner.ts` is counts-only (the new
 * streaming pipeline tallies per page in `onPage`), but we still need to
 * surface the parsed pages so the dispatcher in `process-run.ts` can fan
 * them through the same streaming callbacks. Eplatform never produces
 * `unchanged` outcomes — the portal HTML is replaced wholesale each
 * refresh and the indexer's content-hash short-circuit handles the
 * "nothing changed" case downstream.
 */
export type OpenEplatformOutcome = {
  ok: CrawlPage[];
  failed: FailedUrl[];
};
import { noopLogger, type Logger } from "../logger";
import { buildUserAgent, DEFAULT_USER_AGENT } from "../options";
import {
  OPEN_EPLATFORM_PROVIDER,
  OpenEplatformPageMetadataSchema,
  type OpenEplatformOverview,
  type OpenEplatformPageMetadata,
} from "./types";
import { parseEservices, probePortal } from "./parser";
import { parseOverview } from "./overview-parser";

export type OpenEplatformRunnerInput = {
  /** The portal root URL the operator entered (e.g. https://sjalvservice.sundsvall.se). */
  seedUrl: string;
  /** Display name to copy onto every emitted page's metadata. */
  municipalityName?: string | null;
  /** Override the fetch implementation (tests inject a stub). */
  fetchImpl?: typeof fetch;
  /** HTTP request timeout in ms; default 30s, matches stellan's httpx settings. */
  timeoutMs?: number;
  /**
   * Cap on simultaneous overview-page fetches. Portals are happy to serve
   * a few requests in parallel but we don't want to look like a scraper —
   * default 4 is conservative and matches the Crawlee defaults.
   */
  overviewConcurrency?: number;
  /** Structural pino-compatible logger; silent when omitted. */
  logger?: Logger;
  /** Product token for User-Agent headers. Default `"kravla"`. */
  userAgent?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OVERVIEW_CONCURRENCY = 4;

export async function runOpenEplatformCrawl(
  input: OpenEplatformRunnerInput,
): Promise<OpenEplatformOutcome> {
  const logger = input.logger ?? noopLogger;
  const log = logger.child({ runner: "open-eplatform", seed: input.seedUrl });
  const userAgent = buildUserAgent(input.userAgent ?? DEFAULT_USER_AGENT, "open-eplatform-crawler");
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const portalUrl = normalisePortalUrl(input.seedUrl);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let html: string;
  let httpStatus: number;
  try {
    const res = await fetchImpl(portalUrl, {
      signal: ac.signal,
      headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    httpStatus = res.status;
    if (!res.ok) {
      const failed: FailedUrl = {
        url: portalUrl,
        status: "http_error",
        httpStatus,
        errorMessage: `portal returned HTTP ${httpStatus}`,
      };
      return { ok: [], failed: [failed] };
    }
    html = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: FailedUrl["status"] =
      err instanceof Error && (err.name === "AbortError" || /timeout/i.test(message))
        ? "timeout"
        : "fetch_error";
    return {
      ok: [],
      failed: [{ url: portalUrl, status, errorMessage: message }],
    };
  } finally {
    clearTimeout(timer);
  }

  const probe = probePortal(html);
  if (!probe.isOpenEplatform) {
    return {
      ok: [],
      failed: [
        {
          url: portalUrl,
          status: "fetch_error",
          errorMessage:
            "URL returned HTML but did not look like an Open ePlatform portal " +
            "(no `flowtype_` sections and no Open ePlatform / Nordic Peak hint in <meta>). " +
            `Hints found: ${probe.detectedHints.slice(0, 3).join(" | ") || "(none)"}`,
        },
      ],
    };
  }

  const parsed = parseEservices(html);
  if (parsed.length === 0) {
    log.warn({}, "Open ePlatform portal parsed cleanly but had 0 services — treating as failed");
    return {
      ok: [],
      failed: [
        {
          url: portalUrl,
          status: "fetch_error",
          errorMessage:
            "portal HTML matched Open ePlatform structure but contained 0 services. " +
            "Either the portal is empty or the parser needs an update for this deployment.",
        },
      ],
    };
  }

  const pages: CrawlPage[] = [];
  const seenUrls = new Set<string>();
  const municipalityName = input.municipalityName?.trim() || null;
  // Track which pages need overview enrichment (skip externals + URL-less
  // entries — externals point off-portal and aren't Nordic Peak overviews).
  const overviewTargets: { pageIndex: number; overviewUrl: string }[] = [];

  for (const svc of parsed) {
    const serviceUrl = resolveServiceUrl(portalUrl, svc.servicePath);
    // Each emitted page needs a stable, unique URL — `page.url` is UNIQUE.
    // Prefer the resolved service URL; fall back to a synthetic
    // `portalUrl#flow=<id>` so a portal with multiple services missing
    // hrefs still indexes (rare but observed during fixture capture).
    const pageUrl = serviceUrl ?? `${portalUrl}#flow=${svc.flowId ?? `synth-${pages.length}`}`;
    if (seenUrls.has(pageUrl)) continue;
    seenUrls.add(pageUrl);

    const metadata: OpenEplatformPageMetadata = OpenEplatformPageMetadataSchema.parse({
      provider: OPEN_EPLATFORM_PROVIDER,
      serviceName: svc.name,
      description: svc.description ?? "",
      category: svc.category,
      requiresLogin: svc.requiresLogin,
      isExternal: svc.isExternal,
      serviceUrl: serviceUrl,
      portalUrl,
      municipalityName,
      upstreamFlowId: svc.flowId,
      upstreamOverviewId: svc.overviewId,
      overview: null,
    });

    const page: CrawlPage = {
      url: pageUrl,
      title: svc.name,
      rawText: renderServiceMarkdown(metadata),
      // The eplatform runner doesn't do conditional GETs (the catalog HTML
      // is replaced wholesale each refresh), so etag/lastModified are
      // always null — the indexer's content-hash short-circuit still
      // skips re-embedding when nothing changed.
      etag: null,
      lastModified: null,
      // The catalog carries no per-service date signal.
      publishedAt: null,
      modifiedAt: null,
      dateSources: null,
      fetchedAt: new Date().toISOString(),
      // No in-page document links to discover — services are self-contained
      // flows, not link hubs. Empty array keeps shape parity with the
      // generic runner so the streaming dispatcher doesn't special-case us.
      fileLinks: [],
      metadata,
      extraChunks: extraChunksFor(metadata),
    };
    pages.push(page);

    if (serviceUrl && !svc.isExternal) {
      overviewTargets.push({ pageIndex: pages.length - 1, overviewUrl: serviceUrl });
    }
  }

  await enrichWithOverviews({
    targets: overviewTargets,
    pages,
    fetchImpl,
    timeoutMs,
    concurrency: input.overviewConcurrency ?? DEFAULT_OVERVIEW_CONCURRENCY,
    log,
    userAgent,
  });

  return { ok: pages, failed: [] };
}

/**
 * Per-page parallel fetch + parse of the service overview. Bounded by
 * `concurrency` so we don't blast the portal with one request per service
 * (small portals: 10-20 services, big ones: 200+). Per-page failures are
 * swallowed at the warn level — overview enrichment is best-effort and
 * the catalog data alone is still useful.
 */
type EnrichArgs = {
  targets: { pageIndex: number; overviewUrl: string }[];
  pages: CrawlPage[];
  fetchImpl: typeof fetch;
  timeoutMs: number;
  concurrency: number;
  log: Logger;
  userAgent: string;
};

async function enrichWithOverviews(args: EnrichArgs): Promise<void> {
  if (args.targets.length === 0) return;
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= args.targets.length) return;
      const target = args.targets[i];
      if (!target) return;
      const overview = await fetchAndParseOverview(
        target.overviewUrl,
        args.fetchImpl,
        args.timeoutMs,
        args.log,
        args.userAgent,
      );
      if (!overview) continue;
      const page = args.pages[target.pageIndex];
      if (!page) continue;
      const meta = page.metadata as OpenEplatformPageMetadata;
      meta.overview = overview;
      // Long-form description rides into the embedding pipeline as an extra
      // chunk so semantic queries can hit on it without bloating rawText —
      // per the operator's directive that overview content stay in metadata.
      if (overview.descriptionText) {
        (page.extraChunks ??= []).push(overview.descriptionText);
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, () => worker());
  await Promise.all(workers);
}

async function fetchAndParseOverview(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  log: Logger,
  userAgent: string,
): Promise<OpenEplatformOverview | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!res.ok) {
      log.warn({ url, status: res.status }, "overview fetch returned non-2xx");
      return null;
    }
    const html = await res.text();
    return parseOverview(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ url, err: message }, "overview fetch failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The portal URL operators paste is sometimes `https://sjalvservice.sundsvall.se`,
 * sometimes with a trailing slash, sometimes with `/`. Normalise so every
 * synthetic fragment URL we emit is stable across runs (changing it would
 * break `page.url` uniqueness on re-crawl).
 */
function normalisePortalUrl(raw: string): string {
  const u = new URL(raw);
  // Drop trailing slash on path-only-root URLs; keep deeper paths intact.
  if (u.pathname === "/" || u.pathname === "") {
    return `${u.origin}/`;
  }
  return u.toString();
}

function resolveServiceUrl(portalUrl: string, path: string | null): string | null {
  if (!path) return null;
  try {
    return new URL(path, portalUrl).toString();
  } catch {
    return null;
  }
}

/**
 * The primary chunk text. Markdown-flavoured so it reads sensibly if a
 * generic `search_knowledge` tool ever lands on this collection — and so
 * the embedding model has structure cues (`# heading`, bullet labels)
 * to weight on.
 */
function renderServiceMarkdown(m: OpenEplatformPageMetadata): string {
  const lines: string[] = [`# ${m.serviceName}`];
  if (m.category) lines.push(`Category: ${m.category}`);
  if (m.municipalityName) lines.push(`Municipality: ${m.municipalityName}`);
  lines.push(`Requires login: ${m.requiresLogin ? "yes" : "no"}`);
  if (m.isExternal) lines.push(`External service: yes`);
  if (m.description) lines.push("", m.description);
  if (m.serviceUrl) lines.push("", `Link: ${m.serviceUrl}`);
  return lines.join("\n");
}

/**
 * Per-field views. Each becomes one extra chunk after `splitText` (short
 * enough to fit in one token-budget chunk) so the embedding index gets a
 * "name + category" vector and a bare-name vector alongside the full body.
 * Improves recall on short keyword queries like "snöröjning" or
 * "ansök bygglov".
 */
function extraChunksFor(m: OpenEplatformPageMetadata): string[] {
  const chunks: string[] = [];
  if (m.category) chunks.push(`${m.category}: ${m.serviceName}`);
  chunks.push(m.serviceName);
  return chunks;
}
