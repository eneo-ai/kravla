// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sitemap loader tests, fixture-server style. We're regression-testing
 * against the HTTP/2 bug that the old Crawlee-based loader silently
 * failed on — manifested as `parseSitemap` returning zero entries on
 * real Sitevision/EpiServer sites. The new loader uses native `fetch`
 * and bypasses that path entirely.
 *
 * Server pattern: one server per test, started in `beforeEach` with a
 * mutable `routes` map. Tests register routes via `setRoutes()`, which
 * lets the index XML reference the actual port the test is listening
 * on. (The earlier "start → close → restart" pattern picked a fresh
 * random port on the second listen, leaving the index XML pointing
 * at a dead port.)
 *
 * Coverage:
 *   - Flat urlset (EpiServer-style)
 *   - Sitemap index → sub-sitemap (Sitevision-style)
 *   - Nested index of indexes (depth-capped recursion)
 *   - Gzipped sub-sitemap (`.xml.gz`) + gzipped path-probe discovery
 *   - No sitemap discovered (loader returns clean empty)
 *   - Partial failure: one sub 404s, the other succeeds
 *   - Transient 5xx retried with backoff then succeeds
 *   - Hash stability across loads
 *   - Discovery / probeSitemapStatus: SiteVision /sitemapindex.xml,
 *     soft-404 + 202 rejection (body-sniff), and the robots/path/none/
 *     unreachable status taxonomy
 *   - Seed-is-the-sitemap (legacy Eneo convention): the seed's own path
 *     serving sitemap XML wins discovery; XHTML `<?xml` prologs don't
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import {
  alignEntryHostWithSeed,
  discoverSitemapLocations,
  loadSitemap,
  probeSitemapStatus,
  sitemapExists,
} from "../sitemap";

type Route = {
  status: number;
  body: Buffer | string;
  contentType: string;
  headers?: Record<string, string>;
};

let server: Server | null = null;
let port = 0;
// A path maps to a single Route, or a queue of Routes consumed one per
// request (the last entry repeats once exhausted) — used to model a host
// that fails transiently then recovers, for the retry/backoff test.
const routes = new Map<string, Route | Route[]>();

function setRoutes(map: Record<string, Route | Route[]>): void {
  routes.clear();
  for (const [path, route] of Object.entries(map)) routes.set(path, route);
}

const base = () => `http://127.0.0.1:${port}`;

beforeEach(async () => {
  routes.clear();
  await new Promise<void>((resolve) => {
    const s = createServer((req, res) => {
      const path = req.url ?? "/";
      const entry = routes.get(path);
      let route: Route | undefined;
      if (Array.isArray(entry)) {
        route = entry.length > 1 ? entry.shift() : entry[0];
      } else {
        route = entry;
      }
      if (!route) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = route.status;
      res.setHeader("content-type", route.contentType);
      for (const [k, v] of Object.entries(route.headers ?? {})) res.setHeader(k, v);
      res.end(route.body);
    });
    s.listen(0, "127.0.0.1", () => {
      server = s;
      const addr = s.address();
      if (!addr || typeof addr === "string") throw new Error("server not listening");
      port = addr.port;
      resolve();
    });
  });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

const urlsetXml = (
  urls: { loc: string; lastmod?: string }[],
) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`;

const indexXml = (
  subs: { loc: string; lastmod?: string }[],
) => `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${subs.map((s) => `<sitemap><loc>${s.loc}</loc>${s.lastmod ? `<lastmod>${s.lastmod}</lastmod>` : ""}</sitemap>`).join("\n")}
</sitemapindex>`;

const xmlRoute = (body: string): Route => ({
  status: 200,
  contentType: "application/xml",
  body,
});

const redirectRoute = (location: string): Route => ({
  status: 301,
  contentType: "text/plain",
  body: "",
  headers: { location },
});

describe("loadSitemap", () => {
  it("parses a flat urlset with per-URL lastmod (EpiServer style)", async () => {
    setRoutes({
      "/sitemap.xml": xmlRoute(
        urlsetXml([
          { loc: "/a", lastmod: "2025-05-20T08:00:00Z" },
          { loc: "/b", lastmod: "2025-06-01T10:30:00Z" },
        ]),
      ),
    });
    const result = await loadSitemap(base());
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.lastmod?.toISOString()).toBe("2025-05-20T08:00:00.000Z");
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.subStates)).toHaveLength(1);
    expect(result.hash.length).toBeGreaterThan(0);
  });

  it("aligns www-twin entry hosts to the seed host (Drupal apex/www mismatch)", async () => {
    // ai.se shape: the site canonicalizes to one host, but the sitemap
    // declares every <loc> on its www-twin. Needs a name-based host — a
    // `www.` twin of an IP literal does not parse as a URL — so this test
    // runs its own fixture server on `localhost` instead of the shared
    // 127.0.0.1 one. Entries on the www-twin must come back rewritten onto
    // the seed host; a genuine subdomain stays as declared — it is
    // correctly out of scope.
    const s2 = createServer((req, res) => {
      if (req.url === "/sitemap.xml") {
        const seedHost = `http://localhost:${p2}`;
        res.setHeader("content-type", "application/xml");
        res.end(
          urlsetXml([
            { loc: `http://www.localhost:${p2}/page-1`, lastmod: "2025-05-20T08:00:00Z" },
            { loc: `http://www.localhost:${p2}/page-2?lang=sv`, lastmod: "2025-05-21T08:00:00Z" },
            { loc: `http://en.localhost:${p2}/page-3` },
            { loc: `${seedHost}/page-4` },
          ]),
        );
      } else {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => s2.listen(0, "localhost", resolve));
    const addr = s2.address();
    if (!addr || typeof addr === "string") throw new Error("server not listening");
    const p2 = addr.port;
    try {
      const seed = `http://localhost:${p2}`;
      const result = await loadSitemap(seed);
      expect(result.errors).toEqual([]);
      expect(result.entries.map((e) => e.url)).toEqual([
        `${seed}/page-1`,
        `${seed}/page-2?lang=sv`,
        `http://en.localhost:${p2}/page-3`,
        `${seed}/page-4`,
      ]);
      // The sub-state hash is computed over the aligned entries, so a reload
      // of the identical sitemap stays a hash match (short-circuit safe).
      const r2 = await loadSitemap(seed);
      expect(r2.hash).toBe(result.hash);
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });

  it("recurses through a sitemap index → sub-sitemap (Sitevision style)", async () => {
    setRoutes({
      "/sitemap.xml": xmlRoute(
        indexXml([{ loc: `${base()}/sub.xml`, lastmod: "2025-05-25T00:00:00Z" }]),
      ),
      "/sub.xml": xmlRoute(
        urlsetXml([
          { loc: "/x", lastmod: "2025-05-20T00:00:00Z" },
          { loc: "/y", lastmod: "2025-05-21T00:00:00Z" },
        ]),
      ),
    });

    const result = await loadSitemap(base());
    expect(result.entries).toHaveLength(2);
    expect(result.errors).toEqual([]);
    const subKey = Object.keys(result.subStates)[0]!;
    expect(subKey).toContain("/sub.xml");
    expect(result.subStates[subKey]?.lastmod).toBe("2025-05-25T00:00:00Z");
    expect(result.subStates[subKey]?.urlCount).toBe(2);
  });

  it("decodes entity-encoded sub URLs in a sitemap index (Axiell Arena / Liferay)", async () => {
    // Liferay/Arena layout indices reference each sub-sitemap with a
    // query string entity-encoded in the XML: `?p_l_id=74&amp;layoutUuid=…`.
    // The loader must decode before fetching, or the server sees mangled
    // params and re-serves its root index → spurious "nested index".
    // The encoded loc below mixes named (&amp;), decimal (&#38;) and hex
    // (&#x26;) ampersands; all three must resolve to the one real path.
    const encodedSub = `${base()}/sitemap.xml?p_l_id=74&amp;layoutUuid=abc&#38;groupId=233841&#x26;privateLayout=false`;
    const decodedSub = "/sitemap.xml?p_l_id=74&layoutUuid=abc&groupId=233841&privateLayout=false";
    setRoutes({
      "/sitemap.xml": xmlRoute(indexXml([{ loc: encodedSub, lastmod: "2025-05-25T00:00:00Z" }])),
      [decodedSub]: xmlRoute(urlsetXml([{ loc: "/amsele", lastmod: "2025-05-20T00:00:00Z" }])),
    });

    const result = await loadSitemap(base());
    expect(result.entries.map((e) => e.url)).toEqual(["/amsele"]);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.subStates)).toEqual([`${base()}${decodedSub}`]);
  });

  it("dedupes when /sitemap.xml redirects to /wp-sitemap.xml (no double-count)", async () => {
    // No robots.txt → default path probes discover both `/sitemap.xml`
    // (which 301s to `/wp-sitemap.xml`) and `/wp-sitemap.xml` directly.
    // Both resolve to the same index; entries must not be counted twice.
    setRoutes({
      "/sitemap.xml": redirectRoute(`${base()}/wp-sitemap.xml`),
      "/wp-sitemap.xml": xmlRoute(indexXml([{ loc: `${base()}/sub.xml` }])),
      "/sub.xml": xmlRoute(
        urlsetXml([
          { loc: "/x", lastmod: "2025-05-20T00:00:00Z" },
          { loc: "/y", lastmod: "2025-05-21T00:00:00Z" },
        ]),
      ),
    });

    const result = await loadSitemap(base());
    expect(result.discoveredLocations).toEqual([
      `${base()}/sitemap.xml`,
      `${base()}/wp-sitemap.xml`,
    ]);
    expect(result.entries.map((e) => e.url)).toEqual(["/x", "/y"]);
    expect(result.errors).toEqual([]);
    expect(Object.keys(result.subStates)).toEqual([`${base()}/sub.xml`]);
  });

  it("decompresses a gzipped sub-sitemap (.xml.gz)", async () => {
    const subXml = urlsetXml([
      { loc: "/g1", lastmod: "2025-04-01T00:00:00Z" },
      { loc: "/g2", lastmod: "2025-04-02T00:00:00Z" },
    ]);
    const gz = gzipSync(Buffer.from(subXml, "utf8"));
    setRoutes({
      "/sitemap.xml": xmlRoute(
        indexXml([{ loc: `${base()}/sub.xml.gz`, lastmod: "2025-04-05T00:00:00Z" }]),
      ),
      "/sub.xml.gz": { status: 200, contentType: "application/x-gzip", body: gz },
    });

    const result = await loadSitemap(base());
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.url)).toEqual(["/g1", "/g2"]);
  });

  it("returns a clean empty result when no sitemap is discovered", async () => {
    setRoutes({
      "/": { status: 200, contentType: "text/html", body: "ok" },
    });
    const result = await loadSitemap(base());
    expect(result.entries).toEqual([]);
    // No sitemap discovered → no errors AND no entries. The "no silent
    // failure" guarantee applies when discovery finds a location and the
    // load fails — that's the next test.
    expect(result.errors).toEqual([]);
    expect(result.discoveredLocations).toEqual([]);
  });

  it("records a per-sub-sitemap error when one sub fails, keeps the others", async () => {
    setRoutes({
      "/sitemap.xml": xmlRoute(
        indexXml([
          { loc: `${base()}/sub-ok.xml`, lastmod: "2025-05-01T00:00:00Z" },
          { loc: `${base()}/sub-missing.xml`, lastmod: "2025-05-01T00:00:00Z" },
        ]),
      ),
      "/sub-ok.xml": xmlRoute(urlsetXml([{ loc: "/ok", lastmod: "2025-05-01T00:00:00Z" }])),
      // `/sub-missing.xml` deliberately not registered → 404
    });

    const result = await loadSitemap(base());
    expect(result.entries.map((e) => e.url)).toEqual(["/ok"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.location).toContain("/sub-missing.xml");
    expect(result.errors[0]?.message).toMatch(/HTTP 404/);
  });

  it("hash is stable for the same entry set across loads", async () => {
    setRoutes({
      "/sitemap.xml": xmlRoute(
        urlsetXml([
          { loc: "/a", lastmod: "2025-01-01T00:00:00Z" },
          { loc: "/b", lastmod: "2025-01-02T00:00:00Z" },
        ]),
      ),
    });
    const r1 = await loadSitemap(base());
    const r2 = await loadSitemap(base());
    expect(r1.hash).toBe(r2.hash);
    expect(r1.hash).not.toBe("");
  });

  it("recurses through a nested sitemap index (index of indexes)", async () => {
    setRoutes({
      "/sitemap.xml": xmlRoute(
        indexXml([{ loc: `${base()}/mid.xml`, lastmod: "2025-05-25T00:00:00Z" }]),
      ),
      "/mid.xml": xmlRoute(
        indexXml([{ loc: `${base()}/leaf.xml`, lastmod: "2025-05-24T00:00:00Z" }]),
      ),
      "/leaf.xml": xmlRoute(
        urlsetXml([
          { loc: "/n1", lastmod: "2025-05-20T00:00:00Z" },
          { loc: "/n2", lastmod: "2025-05-21T00:00:00Z" },
        ]),
      ),
    });

    const result = await loadSitemap(base());
    expect(result.entries.map((e) => e.url)).toEqual(["/n1", "/n2"]);
    expect(result.errors).toEqual([]);
    // The leaf urlset inherits the lastmod from its immediate parent index
    // entry (mid.xml's `<sitemap><lastmod>`), not the top-level index.
    const leafKey = `${base()}/leaf.xml`;
    expect(result.subStates[leafKey]?.lastmod).toBe("2025-05-24T00:00:00Z");
  });

  it("retries a transient 5xx sub-sitemap then succeeds (no recorded error)", async () => {
    setRoutes({
      "/sitemap.xml": xmlRoute(indexXml([{ loc: `${base()}/sub.xml` }])),
      // 503 twice, then the real urlset — exercises fetchWithRetry's budget.
      "/sub.xml": [
        { status: 503, contentType: "text/plain", body: "busy" },
        { status: 503, contentType: "text/plain", body: "busy" },
        xmlRoute(urlsetXml([{ loc: "/r1", lastmod: "2025-05-20T00:00:00Z" }])),
      ],
    });

    const result = await loadSitemap(base());
    expect(result.entries.map((e) => e.url)).toEqual(["/r1"]);
    expect(result.errors).toEqual([]);
  });

  it("discovers and loads a gzipped sitemap at /sitemap.xml.gz", async () => {
    const gz = gzipSync(
      Buffer.from(urlsetXml([{ loc: "/z1", lastmod: "2025-04-01T00:00:00Z" }]), "utf8"),
    );
    setRoutes({
      "/sitemap.xml.gz": { status: 200, contentType: "application/gzip", body: gz },
    });

    expect(await discoverSitemapLocations(base())).toEqual([`${base()}/sitemap.xml.gz`]);
    const result = await loadSitemap(base());
    expect(result.entries.map((e) => e.url)).toEqual(["/z1"]);
  });
});

describe("probeSitemapStatus / discovery", () => {
  it("finds the SiteVision /sitemapindex.xml when /sitemap.xml is an HTML soft-404", async () => {
    // The dominant Swedish-municipal CMS serves its sitemap at
    // /sitemapindex.xml. A bare HEAD probe would have accepted the 200-HTML
    // soft-404 at /sitemap.xml and made it locations[0] — body-sniffing drops
    // it so the real index is discovered.
    setRoutes({
      "/sitemap.xml": { status: 200, contentType: "text/html", body: "<html>not found</html>" },
      "/sitemapindex.xml": xmlRoute(
        indexXml([{ loc: `${base()}/sub.xml`, lastmod: "2025-05-25T00:00:00Z" }]),
      ),
      "/sub.xml": xmlRoute(urlsetXml([{ loc: "/sv1", lastmod: "2025-05-20T00:00:00Z" }])),
    });

    const status = await probeSitemapStatus(base());
    expect(status.status).toBe("path");
    expect(status.locations).toEqual([`${base()}/sitemapindex.xml`]);

    const result = await loadSitemap(base());
    expect(result.entries.map((e) => e.url)).toEqual(["/sv1"]);
    expect(result.errors).toEqual([]);
  });

  it("rejects an HTML soft-404 served with status 200 at /sitemap.xml", async () => {
    setRoutes({
      "/sitemap.xml": {
        status: 200,
        contentType: "text/html",
        body: "<html><body>Page not found</body></html>",
      },
      "/": { status: 200, contentType: "text/html", body: "ok" },
    });
    expect(await discoverSitemapLocations(base())).toEqual([]);
    expect(await sitemapExists(base())).toBe(false);
  });

  it("rejects a 202 bot-challenge as not-a-sitemap", async () => {
    setRoutes({
      "/sitemap.xml": { status: 202, contentType: "text/html", body: "<html>challenge</html>" },
      "/": { status: 200, contentType: "text/html", body: "ok" },
    });
    expect(await discoverSitemapLocations(base())).toEqual([]);
    expect(await sitemapExists(base())).toBe(false);
  });

  it("status: robots when robots.txt declares a sitemap at a non-default path", async () => {
    setRoutes({
      "/robots.txt": {
        status: 200,
        contentType: "text/plain",
        body: `User-agent: *\nSitemap: ${base()}/custom/my-sitemap.xml`,
      },
      "/custom/my-sitemap.xml": xmlRoute(urlsetXml([{ loc: "/c1" }])),
    });
    const status = await probeSitemapStatus(base());
    expect(status.status).toBe("robots");
    expect(status.locations).toEqual([`${base()}/custom/my-sitemap.xml`]);
  });

  it("uses the seed itself when it points directly at a sitemap (legacy Eneo seeds)", async () => {
    // Old Eneo versions stored sitemap sources with the sitemap path
    // included. The seed's own document must win over robots.txt — the
    // source was saved against THAT sitemap, not whatever robots points
    // at today.
    setRoutes({
      "/robots.txt": {
        status: 200,
        contentType: "text/plain",
        body: `User-agent: *\nSitemap: ${base()}/other.xml`,
      },
      "/other.xml": xmlRoute(urlsetXml([{ loc: "/from-robots" }])),
      "/sv/custom-sitemap.xml": xmlRoute(
        urlsetXml([{ loc: "/a", lastmod: "2025-05-20T00:00:00Z" }, { loc: "/b" }]),
      ),
    });

    const seed = `${base()}/sv/custom-sitemap.xml`;
    const status = await probeSitemapStatus(seed);
    expect(status.status).toBe("path");
    expect(status.locations).toEqual([seed]);

    const result = await loadSitemap(seed);
    expect(result.discoveredLocations).toEqual([seed]);
    expect(result.entries.map((e) => e.url)).toEqual(["/a", "/b"]);
    expect(result.errors).toEqual([]);
  });

  it("does not mistake an XHTML page seed (<?xml prolog) for a sitemap", async () => {
    setRoutes({
      "/upplev": {
        status: 200,
        contentType: "application/xhtml+xml",
        body: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><body>ok</body></html>`,
      },
      "/": { status: 200, contentType: "text/html", body: "ok" },
    });
    const status = await probeSitemapStatus(`${base()}/upplev`);
    expect(status.status).toBe("none");
    expect(status.locations).toEqual([]);
  });

  it("status: none when the host is up but serves no sitemap", async () => {
    setRoutes({ "/": { status: 200, contentType: "text/html", body: "ok" } });
    const status = await probeSitemapStatus(base());
    expect(status.status).toBe("none");
    expect(status.locations).toEqual([]);
  });

  it("status: unreachable when the host does not respond", async () => {
    // Close the fixture server so its port refuses connections, then probe it.
    const dead = base();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const status = await probeSitemapStatus(dead);
    expect(status.status).toBe("unreachable");
    expect(status.locations).toEqual([]);
  });
});

describe("alignEntryHostWithSeed", () => {
  it("rewrites an apex entry onto a www seed (the ai.se case)", () => {
    expect(alignEntryHostWithSeed("https://ai.se/en/news?p=1", "www.ai.se")).toBe(
      "https://www.ai.se/en/news?p=1",
    );
  });

  it("rewrites a www entry onto an apex seed", () => {
    expect(alignEntryHostWithSeed("https://www.ai.se/x", "ai.se")).toBe("https://ai.se/x");
  });

  it("preserves scheme, port, query, and fragment", () => {
    expect(alignEntryHostWithSeed("http://ai.se:8080/a?b=1#c", "www.ai.se")).toBe(
      "http://www.ai.se:8080/a?b=1#c",
    );
  });

  it("leaves a genuine subdomain untouched", () => {
    expect(alignEntryHostWithSeed("https://en.ai.se/x", "www.ai.se")).toBe("https://en.ai.se/x");
    expect(alignEntryHostWithSeed("https://en.ai.se/x", "ai.se")).toBe("https://en.ai.se/x");
  });

  it("leaves an unrelated host untouched", () => {
    expect(alignEntryHostWithSeed("https://other.se/x", "www.ai.se")).toBe("https://other.se/x");
  });

  it("returns same-host and unparseable entries verbatim", () => {
    expect(alignEntryHostWithSeed("https://ai.se/x", "ai.se")).toBe("https://ai.se/x");
    expect(alignEntryHostWithSeed("/relative/path", "ai.se")).toBe("/relative/path");
  });
});
