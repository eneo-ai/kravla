# kravla

Polite web crawler. Crawlee-based page crawling, sitemap and RSS/Atom ingestion, Open ePlatform
e-service harvesting, platform detection (Sitevision, EpiServer, Netpublicator, …) and
Readability-based content extraction. Works on any site; battle-tested against hundreds of real
Swedish municipal hosts and their CDN quirks.

| Package                              | What it is                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- |
| [`kravla`](packages/core)            | The crawler library — embed it in-process (Node ≥ 20, ESM).                |
| [`kravla-service`](packages/service) | Headless HTTP wrapper — NDJSON streaming + signed webhooks, one container. |

Neither package is published to a registry — the release artifact is the container image
[`ghcr.io/eneo-ai/kravla`](https://github.com/eneo-ai/kravla/pkgs/container/kravla).

## Library quick start

```ts
import { runCrawl } from "kravla";

const outcome = await runCrawl({
  seedUrl: "https://www.example.se",
  crawlType: "crawl", // "crawl" | "sitemap" | "feed" | "open_eplatform"
  depth: 2,
  logger: pinoInstance, // optional — any pino-compatible logger; silent by default
  userAgent: "kravla", // robots.txt token + User-Agent base
  onPage: async (page) => {
    // page.url, page.title, page.rawText (markdown), page.metadata,
    // page.detectedPlatforms, page.fileLinks, etag/lastModified …
  },
  onFailed: async (failure) => {},
});
```

robots.txt is always honored (no opt-out): rules are matched against the `userAgent` token,
`Crawl-delay` is enforced as a hard same-host gap, and `Sitemap:` directives drive discovery.

Runtime knobs (all optional, defaults in parentheses): `pageConcurrency` (1), `memoryMbytes`
(1024), `requestHandlerTimeoutSecs` (900), `maxHtmlBytes` (8 MiB, 0 = unlimited).

### Other entry points

- `previewCrawlSource(input)` — dry-run estimate (seed probe + robots + sitemap + sample crawl).
- `loadSitemap(seedUrl)` / `probeSitemapStatus(seedUrl)` — native-fetch sitemap loader
  (sidesteps the got-scraping HTTP/2 bug that breaks CDN-fronted .se hosts).
- `fetchAndParseFeed(url)` — RSS/Atom with autodiscovery and conditional GET.
- `runOpenEplatformCrawl(input)` — harvest an Open ePlatform e-service catalog. The optional
  `municipalityName` is caller-supplied display data — kravla ships no municipality registry.
- `loadRobotsPolicyForUrl`, `canonicalizeSourceUrl`, `extractContent`, `runDetectors`,
  `runEnrichers`, …

## Run as a service

For non-Node consumers (anything that speaks HTTP), run the headless service instead of
embedding the library — one container, one API key, HTTP in / pages out:

```sh
# local
CRAWLER_API_KEY=changeme bun packages/service/src/index.ts

# container
docker build -t kravla-service .
docker run -p 8080:8080 -e CRAWLER_API_KEY=changeme kravla-service
# (or pull ghcr.io/eneo-ai/kravla once a release is tagged)
```

Then stream a crawl as NDJSON:

```sh
curl -N -X POST http://localhost:8080/v1/crawls \
  -H "authorization: Bearer changeme" -H "content-type: application/json" \
  -d '{"url": "https://www.example.se", "depth": 1, "limits": {"max_pages": 50}}'
```

Rolling your own image instead? Crawlee ≥ 3.17 measures memory by spawning `ps`, so slim/distroless
bases need `procps` installed (the shipped Dockerfile does this) — otherwise every snapshot logs
`Executable not found in $PATH: "ps"`.

Each line is one event (`robots`, `page`, `failed`, …) ending with a terminal `done` summary.
Webhook delivery (HMAC-signed batches + job status/cancel endpoints), the `/v1/preview` dry-run,
and the full env-var reference are documented in
[`packages/service/README.md`](packages/service/README.md).

## Development

```sh
bun install
bun run build   # required first: the service imports kravla from core's dist
bun run typecheck && bun run lint && bun run test
```

The service loads core through its published entry point (`packages/core/dist`), at runtime as
well as for types — so changes under `packages/core/src` don't reach a running service until
`bun run build` regenerates dist. `bun run dev` in `packages/service` restarts on service-src
changes (and on a core rebuild); pair it with `bunx tsup --watch` in `packages/core` when
iterating on core.

QA tooling lives in [`scripts/`](scripts): `bun run extraction:fidelity` compares extraction
candidates against captured fixtures.

## License

[AGPL-3.0-only](LICENSE) © 2026 Oddly Even AB and contributors.

kravla was donated to the [eneo-ai](https://github.com/eneo-ai) organization by
[Oddly Even AB](https://github.com/Oddly-Even). Versions up to and including 0.3.1 were
released under the MIT license from [Oddly-Even/kravla](https://github.com/Oddly-Even/kravla);
that history (and its MIT licensing) is preserved in this repository's tags `v0.1.0`–`v0.3.0`.
