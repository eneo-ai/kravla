# kravla-service

Headless HTTP wrapper around [`kravla`](../core). One container, one static API key,
HTTP in / pages out. No persistence or queue — a restart forgets running jobs and callers
re-submit; retries and scheduling belong to the consumer.

## Run

```sh
# local — `bun run build` first: the service imports kravla from core's dist,
# so a fresh clone (or any packages/core/src change) needs a rebuild to take effect
CRAWLER_API_KEY=changeme bun packages/service/src/index.ts
# or, auto-restarting on service-src changes and core rebuilds:
cd packages/service && CRAWLER_API_KEY=changeme bun run dev

# container
docker run -p 8080:8080 -e CRAWLER_API_KEY=changeme ghcr.io/eneo-ai/kravla
```

| Env var                               | Default  | Meaning                                                       |
| ------------------------------------- | -------- | ------------------------------------------------------------- |
| `CRAWLER_API_KEY`                     | —        | Required (or set `KRAVLA_AUTH_DISABLED=true`, dev only).      |
| `PORT`                                | `8080`   | Listen port.                                                  |
| `HEALTH_PORT`                         | unset    | Optional extra listener serving only `/healthz`.              |
| `MAX_CONCURRENT_CRAWLS`               | `2`      | Active jobs beyond which submissions get `429`.               |
| `KRAVLA_WEBHOOK_ALLOW_PRIVATE`        | `false`  | Allow webhook callbacks to private addresses (dev/test only). |
| `KRAVLA_USER_AGENT`                   | `kravla` | robots.txt token + User-Agent base for all jobs.              |
| `KRAVLA_PAGE_CONCURRENCY`             | `1`      | Concurrent page fetches inside one crawl.                     |
| `KRAVLA_MEMORY_MBYTES`                | `1024`   | Crawlee pool budget per crawl — **not** a container limit.    |
| `KRAVLA_REQUEST_HANDLER_TIMEOUT_SECS` | `900`    | Per-page handler cap.                                         |
| `KRAVLA_MAX_HTML_BYTES`               | 8 MiB    | Max HTML body accepted; `0` disables.                         |

Auth on every `/v1/*` route: `Authorization: Bearer <key>` (or `X-Api-Key: <key>`).
robots.txt is always honored — there is no opt-out.

## POST /v1/crawls

```jsonc
{
  "url": "https://www.example.se",
  "crawl_type": "crawl", // crawl | sitemap | feed | open_eplatform
  "depth": 1,
  "scope": "depth_limited", // or path_prefix
  "http_auth": { "user": "u", "password": "p" },
  "exclude_url_patterns": ["*/kalender/*"],
  "index_linked_files": true,
  "limits": {
    "max_pages": 500,
    "max_seconds": 1800,
    "max_requests_per_minute": 60,
    "request_delay_seconds": 1,
  },
  "conditional_gets": [{ "url": "https://…", "etag": "\"abc\"", "last_modified": "…" }],
  // URLs already processed in a prior attempt — counted as skipped, not re-delivered.
  "skip_urls": ["https://…"],
  // sitemap mode only: pre-resolved URLs; skips the service's own sitemap
  // discovery so caller-side filtering (e.g. by lastmod) is preserved.
  "sitemap_urls": ["https://…"],
  // open_eplatform mode only: display name stamped on page metadata.
  "municipality_name": "Sundsvall",
  "user_agent": "kravla", // per-job override of the robots/UA token
  "delivery": { "mode": "stream" }, // default
}
```

### Stream delivery (default)

`200` with `application/x-ndjson`. One JSON object per line, in crawl order:

```
{"type":"robots","robots":{"found":true,"seed_allowed":true,…}}
{"type":"page","page":{"url":…,"title":…,"raw_text":…,"etag":…,"last_modified":…,"file_links":[…],"metadata":…,"extra_chunks":…,"detected_platforms":[…]}}
{"type":"unchanged","url":…}                         // conditional GET answered 304
{"type":"failed","url":…,"status":"http_error|timeout|fetch_error","http_status":…,"error_message":…}
{"type":"skipped_robots","url":…}
{"type":"skipped_unavailable","url":…,"http_status":401}
{"type":"done","status":"completed|cancelled|failed","outcome":{"ok_count":…,…},"error":…}
```

Cancel by dropping the connection — the crawl aborts within a page.
`conditional_gets` keys are exact-match against crawled URLs; echo back URLs from prior
`page` events together with their `etag`/`last_modified` to skip unchanged pages.

### Webhook delivery

One crawl can fan out to up to 5 receivers — e.g. a search indexer AND an archival store get the
same crawl without the site being crawled twice:

```jsonc
"delivery": {
  "mode": "webhook",
  "targets": [
    { "url": "https://indexer.example/hook", "secret": "…≥16 chars…", "batch_size": 25, "name": "indexer" },
    { "url": "https://archive.example/hook", "secret": "…another…",   "name": "archive" }
  ]
}
```

(The legacy flat shape `{ "mode": "webhook", "url", "secret", "batch_size" }` still works as a
single target — deprecated, removed at beta.)

Returns `202 {"job_id": "<uuid>"}` immediately. Events are POSTed to each target in batches:

```jsonc
{ "job_id": "…", "sequence": 3, "events": [ … ], "done": { … } } // "done" only on the final POST
```

Headers: `X-Kravla-Signature: sha256=<hex HMAC-SHA256 of the raw body>`, `X-Kravla-Job-Id`,
`X-Kravla-Sequence`. Every target receives the identical event stream with its own gapless
1..n sequence (batch boundaries differ when `batch_size` does). Delivery is awaited by the
crawler, so the slowest healthy receiver backpressures the crawl. A target whose delivery
exhausts retries (3×) is marked failed and excluded from the rest of the job — the crawl and
the other targets continue; when every target has failed, the crawl itself is aborted (nobody
is listening). Webhook URLs must not resolve to private addresses unless
`KRAVLA_WEBHOOK_ALLOW_PRIVATE=true`.

Receivers MUST tolerate `unchanged` events: when the submitter supplies `conditional_gets`,
pages answering 304 carry no body for ANY receiver. 304 means nothing changed, so no receiver
misses updates — but a secondary receiver that tracks per-document freshness should treat
`unchanged` as a "still exists" touch.

Verify in Python:

```python
import hmac, hashlib

def verify(secret: str, raw_body: bytes, signature_header: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)
```

- `GET /v1/crawls/{job_id}` → `{job_id, status, created_at, finished_at, delivered_batches, targets, outcome, error}` where
  `status` ∈ `running|completed|partial|cancelled|failed` (`partial` = crawl finished but only a
  subset of targets got it) and `targets[]` carries per-receiver
  `{name, url, status: delivering|delivered|failed, delivered_batches, error}`.
- `DELETE /v1/crawls/{job_id}` → `202`, aborts the crawl; the final webhook POST to every
  still-healthy target reports `status: "cancelled"`. Cancellation is job-wide — detaching a
  single target is a non-goal (the submitter owns the job).

## POST /v1/preview

Dry-run probe of a candidate source — no indexing, ~seconds:

```jsonc
{ "url": "https://www.example.se", "crawl_type": "crawl", "depth": 1 }
```

`200` with `{seed, robots_txt, sitemap, sample_crawl, warnings}` (seed reachability, robots
verdict, sitemap discovery + URL counts, capped sample crawl, cross-check warnings).

## GET /healthz

`200 {"status":"ok","active_crawls":n}` — unauthenticated, for probes.
