// SPDX-License-Identifier: AGPL-3.0-only
/**
 * End-to-end service tests: real HTTP server on an ephemeral port, real
 * Crawlee runs against the in-process fixture server — no external network.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { noopLogger } from "kravla";
import { createApp } from "../../src/app";
import type { ServiceConfig } from "../../src/config";
import { signBody } from "../../src/webhook";
import { startFixtureServer, type FixtureServer } from "../../../core/tests/helpers/fixture-server";

const API_KEY = "test-key-0123456789";

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    port: 0,
    healthPort: null,
    apiKey: API_KEY,
    maxConcurrentCrawls: 4,
    webhookAllowPrivate: true,
    userAgent: undefined,
    pageConcurrency: undefined,
    memoryMbytes: undefined,
    requestHandlerTimeoutSecs: undefined,
    maxHtmlBytes: undefined,
    ...overrides,
  };
}

async function startService(
  config: ServiceConfig,
): Promise<{ url: string; close: () => Promise<void> }> {
  const { handler } = createApp(config, noopLogger);
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const authHeaders = { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };

let fixtures: FixtureServer;
let service: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  fixtures = await startFixtureServer([
    {
      path: "/",
      title: "Root",
      bodyHtml: '<p>Welcome to the fixture town.</p><a href="/a">A</a><a href="/b">B</a>',
    },
    { path: "/a", title: "Page A", bodyHtml: "<p>Alpha content here.</p>" },
    { path: "/b", title: "Page B", bodyHtml: "<p>Beta content here.</p>" },
  ]);
  service = await startService(makeConfig());
});

afterAll(async () => {
  await service.close();
  await fixtures.close();
});

describe("auth + plumbing", () => {
  it("serves /healthz without auth", async () => {
    const res = await fetch(`${service.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("rejects a missing API key with 401", async () => {
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: fixtures.url }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid body with 400 and zod issues", async () => {
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: "not-a-url", depth: 99 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: unknown[] };
    expect(body.detail.length).toBeGreaterThan(0);
  });

  it("404s on unknown job ids", async () => {
    const res = await fetch(`${service.url}/v1/crawls/00000000-0000-0000-0000-000000000000`, {
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe("wire fields for embedding consumers", () => {
  async function streamEvents(body: object): Promise<{ type: string }[]> {
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
  }

  it("skip_urls suppresses re-delivery and counts the page as skipped", async () => {
    const events = await streamEvents({
      url: fixtures.url,
      crawl_type: "crawl",
      depth: 1,
      skip_urls: [`${fixtures.url}/a`],
    });
    const pages = events.filter((e) => e.type === "page") as { page: { url: string } }[];
    expect(pages.map((p) => p.page.url)).not.toContain(`${fixtures.url}/a`);
    expect(pages.length).toBe(2);
    const done = events.at(-1) as { outcome: { skipped_count: number } };
    expect(done.outcome.skipped_count).toBe(1);
  });

  it("sitemap_urls bypasses service-side sitemap discovery", async () => {
    // The fixture's own /sitemap.xml lists all three pages — if the service
    // consulted it, three pages would come back instead of the two we pass.
    const events = await streamEvents({
      url: fixtures.url,
      crawl_type: "sitemap",
      depth: 0,
      sitemap_urls: [`${fixtures.url}/a`, `${fixtures.url}/b`],
    });
    const pages = events.filter((e) => e.type === "page") as { page: { url: string } }[];
    expect(pages.map((p) => p.page.url).sort()).toEqual([`${fixtures.url}/a`, `${fixtures.url}/b`]);
  });

  it("rejects sitemap_urls outside sitemap mode", async () => {
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        url: fixtures.url,
        crawl_type: "crawl",
        sitemap_urls: [`${fixtures.url}/a`],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects municipality_name outside open_eplatform mode", async () => {
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        url: fixtures.url,
        crawl_type: "crawl",
        municipality_name: "Sundsvall",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("legacy Eneo sitemap-document seed", () => {
  // Sources created by older Eneo versions store `url` = the sitemap document
  // itself (e.g. `https://host/sitemap.xml`). Verifies the pre-existing
  // seed-self-sitemap handling (sitemap.ts probeSitemapStatus + scope.ts
  // sitemapSeedScopeUrl): with NO `sitemap_urls`, Kravla must recognise the
  // seed as the sitemap, load it, and ingest every same-host entry with the
  // scope widened to the site root — NOT path-scoped to `/sitemap.xml` (which
  // would filter out every real page and yield nothing). The fixture's pages
  // sit at unrelated paths, so a naive `/sitemap.xml`-prefix scope would return
  // zero pages; getting all of them proves the widening.
  let legacy: FixtureServer;

  beforeAll(async () => {
    legacy = await startFixtureServer([
      { path: "/", title: "Root", bodyHtml: "<p>Startsida.</p>" },
      { path: "/nyheter/1", title: "Nyhet", bodyHtml: "<p>En nyhet.</p>" },
      { path: "/dokument/a", title: "Dokument", bodyHtml: "<p>Ett dokument.</p>" },
    ]);
  });

  afterAll(async () => {
    await legacy.close();
  });

  it("/v1/crawls: seed=/sitemap.xml ingests every same-host entry unscoped", async () => {
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        url: `${legacy.url}/sitemap.xml`,
        crawl_type: "sitemap",
        depth: 0,
      }),
    });
    expect(res.status).toBe(200);
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
    const pages = events.filter((e) => e.type === "page") as { page: { url: string } }[];
    expect(pages.map((p) => p.page.url).sort()).toEqual([
      `${legacy.url}/`,
      `${legacy.url}/dokument/a`,
      `${legacy.url}/nyheter/1`,
    ]);
    const done = events.at(-1) as { type: string; outcome: { ok_count: number } };
    expect(done.type).toBe("done");
    expect(done.outcome.ok_count).toBe(3);
  });

  it("/v1/preview: seed=/sitemap.xml reflects all entries as in-scope", async () => {
    const res = await fetch(`${service.url}/v1/preview`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: `${legacy.url}/sitemap.xml`, crawl_type: "sitemap", depth: 0 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sitemap: {
        found: boolean;
        url_count: number;
        total_urls_in_sitemap: number;
        locations: string[];
      };
    };
    expect(body.sitemap.found).toBe(true);
    expect(body.sitemap.total_urls_in_sitemap).toBe(3);
    // url_count === total proves nothing was dropped by path-scoping.
    expect(body.sitemap.url_count).toBe(3);
    expect(body.sitemap.locations.some((loc) => loc.endsWith("/sitemap.xml"))).toBe(true);
  });
});

describe("stream mode", () => {
  it("streams NDJSON events and a terminal done", async () => {
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: fixtures.url, crawl_type: "crawl", depth: 1 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");

    const lines = (await res.text()).trim().split("\n");
    const events = lines.map((l) => JSON.parse(l) as { type: string });

    expect(events[0]?.type).toBe("robots");
    const pages = events.filter((e) => e.type === "page") as {
      page: { url: string; title: string; raw_text: string };
    }[];
    expect(pages.length).toBe(3);
    expect(pages.map((p) => p.page.title).sort()).toEqual(["Page A", "Page B", "Root"]);
    expect(pages.every((p) => p.page.raw_text.length > 0)).toBe(true);

    const done = events.at(-1) as { type: string; status: string; outcome: { ok_count: number } };
    expect(done.type).toBe("done");
    expect(done.status).toBe("completed");
    expect(done.outcome.ok_count).toBe(3);
  });

  it("emits normalized date fields resolved from page metadata", async () => {
    fixtures.setFixtures([
      {
        path: "/",
        title: "Dated",
        bodyHtml: "",
        rawBody:
          "<!doctype html><html><head><title>Dated</title>" +
          '<meta property="article:published_time" content="2026-05-20T08:00:00Z">' +
          "</head><body><p>Dated content here.</p></body></html>",
      },
    ]);
    try {
      const res = await fetch(`${service.url}/v1/crawls`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ url: `${fixtures.url}/`, crawl_type: "crawl", depth: 0 }),
      });
      const events = (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string });
      const page = (
        events.find((e) => e.type === "page") as unknown as {
          page: {
            published_at: string | null;
            modified_at: string | null;
            date_sources: Record<string, string> | null;
            fetched_at: string;
          };
        }
      ).page;
      expect(page.published_at).toBe("2026-05-20T08:00:00.000Z");
      expect(page.modified_at).toBeNull();
      expect(page.date_sources).toEqual({ published_at: "meta-article" });
      expect(Date.parse(page.fetched_at)).not.toBeNaN();
    } finally {
      fixtures.setFixtures([
        {
          path: "/",
          title: "Root",
          bodyHtml: '<p>Welcome to the fixture town.</p><a href="/a">A</a><a href="/b">B</a>',
        },
        { path: "/a", title: "Page A", bodyHtml: "<p>Alpha content here.</p>" },
        { path: "/b", title: "Page B", bodyHtml: "<p>Beta content here.</p>" },
      ]);
    }
  });

  it("threads sitemap lastmod into modified_at on service-loaded sitemap crawls", async () => {
    // Same three pages the default sitemap advertises, now with one lastmod.
    fixtures.setSitemapEntries([
      { path: "/" },
      { path: "/a", lastmod: "2026-05-10T00:00:00Z" },
      { path: "/b" },
    ]);
    const res = await fetch(`${service.url}/v1/crawls`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: fixtures.url, crawl_type: "sitemap", depth: 0 }),
    });
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
    const pages = events.filter((e) => e.type === "page") as unknown as {
      page: {
        url: string;
        modified_at: string | null;
        date_sources: Record<string, string> | null;
        metadata: Record<string, unknown> | null;
      };
    }[];
    const pageA = pages.find((p) => p.page.url === `${fixtures.url}/a`)!.page;
    expect(pageA.modified_at).toBe("2026-05-10T00:00:00.000Z");
    expect(pageA.date_sources).toEqual({ modified_at: "sitemap-lastmod" });
    // The raw lastmod stays inspectable on metadata alongside the other
    // per-source raw values, independent of which source won the cascade.
    expect(pageA.metadata?.sitemap).toEqual({ lastmod: "2026-05-10T00:00:00.000Z" });
    const pageB = pages.find((p) => p.page.url === `${fixtures.url}/b`)!.page;
    expect(pageB.modified_at).toBeNull();
    expect(pageB.date_sources).toBeNull();
    expect(pageB.metadata?.sitemap).toBeUndefined();
  });

  it("treats conditional-GET 304s as unchanged events", async () => {
    fixtures.setFixtures([
      { path: "/", title: "Root", bodyHtml: "<p>Etagged page.</p>", etag: '"v1"' },
    ]);
    try {
      // Cache-hint keys are exact-match against the crawled URL — consumers
      // echo back URLs from prior page events, so seed and hint align here.
      const res = await fetch(`${service.url}/v1/crawls`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          url: `${fixtures.url}/`,
          crawl_type: "crawl",
          depth: 0,
          conditional_gets: [{ url: `${fixtures.url}/`, etag: '"v1"' }],
        }),
      });
      const events = (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string });
      expect(events.some((e) => e.type === "unchanged")).toBe(true);
      const done = events.at(-1) as { outcome: { unchanged_count: number } };
      expect(done.outcome.unchanged_count).toBe(1);
    } finally {
      fixtures.setFixtures([
        {
          path: "/",
          title: "Root",
          bodyHtml: '<p>Welcome to the fixture town.</p><a href="/a">A</a><a href="/b">B</a>',
        },
        { path: "/a", title: "Page A", bodyHtml: "<p>Alpha content here.</p>" },
        { path: "/b", title: "Page B", bodyHtml: "<p>Beta content here.</p>" },
      ]);
    }
  });
});

describe("webhook mode", () => {
  type Received = { body: string; signature: string | undefined; sequence: string | undefined };

  async function startReceiver(
    // 400 = deterministic failure (deliverWebhook treats non-408/429 4xx as
    // non-retryable, so failing targets fail fast in tests). delayMs holds the
    // response open — since delivery is awaited by the crawler, this pauses
    // the whole crawl (deterministic mid-run window for e.g. cancellation).
    respondStatus = 200,
    delayMs = 0,
  ): Promise<{
    url: string;
    received: Received[];
    close: () => Promise<void>;
  }> {
    const received: Received[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({
          body: Buffer.concat(chunks).toString("utf8"),
          signature: req.headers["x-kravla-signature"] as string | undefined,
          sequence: req.headers["x-kravla-sequence"] as string | undefined,
        });
        setTimeout(() => {
          res.writeHead(respondStatus);
          res.end();
        }, delayMs);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/hook`,
      received,
      close: () =>
        new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
  }

  type JobStatusBody = {
    status: string;
    outcome: { ok_count: number } | null;
    error: string | null;
    delivered_batches: number;
    targets: { name: string; status: string; delivered_batches: number; error: string | null }[];
  };

  async function pollUntilSettled(jobId: string): Promise<JobStatusBody> {
    let status: JobStatusBody | null = null;
    for (let i = 0; i < 150; i++) {
      const res = await fetch(`${service.url}/v1/crawls/${jobId}`, { headers: authHeaders });
      status = (await res.json()) as JobStatusBody;
      if (status.status !== "running") return status;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`job ${jobId} did not settle; last status ${status?.status}`);
  }

  function eventsOf(received: Received[]): { type: string }[] {
    return received.flatMap((r) => (JSON.parse(r.body) as { events: { type: string }[] }).events);
  }

  it("delivers signed batches, completes, and reports status", async () => {
    const receiver = await startReceiver();
    const secret = "super-secret-webhook-key";
    try {
      const submit = await fetch(`${service.url}/v1/crawls`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          url: fixtures.url,
          crawl_type: "crawl",
          depth: 1,
          delivery: { mode: "webhook", url: receiver.url, secret, batch_size: 2 },
        }),
      });
      expect(submit.status).toBe(202);
      const { job_id } = (await submit.json()) as { job_id: string };
      expect(job_id).toMatch(/^[0-9a-f-]{36}$/);

      // Poll status until the job settles.
      let status: { status: string; outcome: { ok_count: number } | null } | null = null;
      for (let i = 0; i < 100; i++) {
        const res = await fetch(`${service.url}/v1/crawls/${job_id}`, { headers: authHeaders });
        status = (await res.json()) as typeof status;
        if (status && status.status !== "running") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(status?.status).toBe("completed");
      expect(status?.outcome?.ok_count).toBe(3);

      // Batches: 4 events (robots + 3 pages) at batch_size 2, plus done.
      expect(receiver.received.length).toBeGreaterThanOrEqual(2);
      for (const r of receiver.received) {
        expect(r.signature).toBe(signBody(secret, r.body));
      }
      const last = JSON.parse(receiver.received.at(-1)!.body) as {
        done?: { status: string; outcome: { ok_count: number } };
      };
      expect(last.done?.status).toBe("completed");
      expect(last.done?.outcome.ok_count).toBe(3);
      const allEvents = receiver.received.flatMap(
        (r) => (JSON.parse(r.body) as { events: { type: string }[] }).events,
      );
      expect(allEvents.filter((e) => e.type === "page").length).toBe(3);
    } finally {
      await receiver.close();
    }
  });

  it("refuses private webhook targets unless explicitly allowed", async () => {
    const guarded = await startService(makeConfig({ webhookAllowPrivate: false }));
    try {
      const res = await fetch(`${guarded.url}/v1/crawls`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          url: fixtures.url,
          delivery: {
            mode: "webhook",
            url: "http://127.0.0.1:9999/hook",
            secret: "super-secret-webhook-key",
          },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("private");
    } finally {
      await guarded.close();
    }
  });

  describe("fan-out", () => {
    const secretA = "fan-out-secret-aaaaaa";
    const secretB = "fan-out-secret-bbbbbb";

    function submitFanOut(targets: object[], extra: object = {}) {
      return fetch(`${service.url}/v1/crawls`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          url: fixtures.url,
          crawl_type: "crawl",
          depth: 1,
          delivery: { mode: "webhook", targets },
          ...extra,
        }),
      });
    }

    it("delivers the same event stream to every target with independent sequences", async () => {
      const a = await startReceiver();
      const b = await startReceiver();
      try {
        const submit = await submitFanOut([
          { url: a.url, secret: secretA, batch_size: 1, name: "indexer" },
          { url: b.url, secret: secretB, batch_size: 50, name: "archive" },
        ]);
        expect(submit.status).toBe(202);
        const { job_id } = (await submit.json()) as { job_id: string };

        const status = await pollUntilSettled(job_id);
        expect(status.status).toBe("completed");
        expect(status.targets.map((t) => [t.name, t.status])).toEqual([
          ["indexer", "delivered"],
          ["archive", "delivered"],
        ]);

        // Same events on both sides: robots + 3 pages (+ done flag on last POST).
        for (const recv of [a, b]) {
          expect(eventsOf(recv.received).filter((e) => e.type === "page").length).toBe(3);
          const last = JSON.parse(recv.received.at(-1)!.body) as { done?: { status: string } };
          expect(last.done?.status).toBe("completed");
        }
        // batch_size 1 → one POST per event (+ final); batch_size 50 → one POST.
        expect(a.received.length).toBeGreaterThanOrEqual(4);
        expect(b.received.length).toBe(1);

        // Per-target gapless sequences and per-target secrets.
        const sequencesA = a.received.map((r) => Number(r.sequence));
        expect(sequencesA).toEqual(sequencesA.map((_, i) => i + 1));
        for (const r of a.received) expect(r.signature).toBe(signBody(secretA, r.body));
        for (const r of b.received) expect(r.signature).toBe(signBody(secretB, r.body));
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("continues for healthy targets when one fails, settling as partial", async () => {
      const healthy = await startReceiver();
      const broken = await startReceiver(400);
      try {
        const submit = await submitFanOut([
          { url: healthy.url, secret: secretA, batch_size: 1, name: "good" },
          { url: broken.url, secret: secretB, batch_size: 1, name: "bad" },
        ]);
        const { job_id } = (await submit.json()) as { job_id: string };

        const status = await pollUntilSettled(job_id);
        expect(status.status).toBe("partial");
        expect(status.error).toContain("1 of 2");
        expect(status.outcome?.ok_count).toBe(3);

        const bad = status.targets.find((t) => t.name === "bad")!;
        expect(bad.status).toBe("failed");
        expect(bad.error).toContain("HTTP 400");

        const good = status.targets.find((t) => t.name === "good")!;
        expect(good.status).toBe("delivered");
        expect(eventsOf(healthy.received).filter((e) => e.type === "page").length).toBe(3);
      } finally {
        await healthy.close();
        await broken.close();
      }
    });

    it("aborts the crawl and fails the job when every target fails", async () => {
      const brokenA = await startReceiver(400);
      const brokenB = await startReceiver(400);
      try {
        const submit = await submitFanOut([
          { url: brokenA.url, secret: secretA, batch_size: 1 },
          { url: brokenB.url, secret: secretB, batch_size: 1 },
        ]);
        const { job_id } = (await submit.json()) as { job_id: string };

        const status = await pollUntilSettled(job_id);
        expect(status.status).toBe("failed");
        expect(status.error).toBe("all delivery targets failed");
        // Both targets got exactly the one POST that failed them.
        expect(brokenA.received.length).toBe(1);
        expect(brokenB.received.length).toBe(1);
      } finally {
        await brokenA.close();
        await brokenB.close();
      }
    });

    it("rejects mixing targets with the legacy flat fields", async () => {
      const res = await fetch(`${service.url}/v1/crawls`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          url: fixtures.url,
          delivery: {
            mode: "webhook",
            url: "https://example.com/hook",
            secret: "super-secret-webhook-key",
            targets: [{ url: "https://example.com/hook2", secret: "super-secret-webhook-key" }],
          },
        }),
      });
      expect(res.status).toBe(400);
    });

    it("names the offending target when SSRF-refusing a fan-out submission", async () => {
      const guarded = await startService(makeConfig({ webhookAllowPrivate: false }));
      try {
        const res = await fetch(`${guarded.url}/v1/crawls`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            url: fixtures.url,
            delivery: {
              mode: "webhook",
              targets: [
                { url: "https://example.com/hook", secret: secretA },
                { url: "http://127.0.0.1:9999/hook", secret: secretB, name: "internal" },
              ],
            },
          }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("internal");
        expect(body.error).toContain("private");
      } finally {
        await guarded.close();
      }
    });

    it("delivers done:cancelled to every target when the job is cancelled", async () => {
      // Receiver a answers each POST only after 3s — the awaited delivery
      // pins the crawl mid-run, so the DELETE below deterministically lands
      // while the job is still running.
      const a = await startReceiver(200, 3_000);
      const b = await startReceiver();
      try {
        const submit = await submitFanOut([
          { url: a.url, secret: secretA, batch_size: 1 },
          { url: b.url, secret: secretB, batch_size: 1 },
        ]);
        const { job_id } = (await submit.json()) as { job_id: string };

        // Wait until the first POST is in flight (recorded before the delay).
        for (let i = 0; i < 100 && a.received.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const del = await fetch(`${service.url}/v1/crawls/${job_id}`, {
          method: "DELETE",
          headers: authHeaders,
        });
        expect(del.status).toBe(202);

        const status = await pollUntilSettled(job_id);
        expect(status.status).toBe("cancelled");
        for (const recv of [a, b]) {
          const last = JSON.parse(recv.received.at(-1)!.body) as { done?: { status: string } };
          expect(last.done?.status).toBe("cancelled");
        }
      } finally {
        await a.close();
        await b.close();
      }
    });
  });
});

describe("preview + backpressure", () => {
  it("previews a source", async () => {
    const res = await fetch(`${service.url}/v1/preview`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: fixtures.url, crawl_type: "crawl", depth: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seed: { reachable: boolean };
      sample_crawl: { urls_discovered: number };
    };
    expect(body.seed.reachable).toBe(true);
    expect(body.sample_crawl.urls_discovered).toBeGreaterThanOrEqual(3);
  });

  it("429s when the concurrency cap is reached", async () => {
    const capped = await startService(makeConfig({ maxConcurrentCrawls: 0 }));
    try {
      const res = await fetch(`${capped.url}/v1/crawls`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ url: fixtures.url }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("30");
    } finally {
      await capped.close();
    }
  });
});
