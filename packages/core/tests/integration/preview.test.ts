// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dry-run / preview acceptance: hybrid sitemap probe + sample crawl.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewCrawlSource } from "../../src/preview";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer(
    [
      {
        path: "/seed",
        title: "Seed",
        bodyHtml:
          '<a href="/about">About</a><a href="/contact">Contact</a><a href="/news">News</a><a href="/loggain?redirect=%2Fseed%3Ftriggerlogin%3D1">Login</a>',
      },
      {
        path: "/about",
        title: "About",
        bodyHtml: '<p>About us.</p><a href="/team">Team</a>',
      },
      { path: "/contact", title: "Contact", bodyHtml: "<p>Contact info.</p>" },
      { path: "/news", title: "News", bodyHtml: "<p>Latest news.</p>" },
      { path: "/team", title: "Team", bodyHtml: "<p>Our team.</p>" },
    ],
    {
      advertiseSitemap: true,
      sitemapPaths: ["/seed", "/about", "/contact", "/news", "/team"],
    },
  );
});

afterAll(async () => {
  await server.close();
});

describe("dry-run preview", () => {
  it("hybrid probe: discovers sitemap from robots.txt + counts URLs, runs sample-crawl + seed-reachability in parallel", async () => {
    const result = await previewCrawlSource({
      url: `${server.url}/seed`,
      crawlType: "crawl",
      depth: 2,
      maxSampleFetches: 10,
    });

    expect(result.method).toBe("hybrid");

    // Seed reachable, served HTML
    expect(result.seed.reachable).toBe(true);
    expect(result.seed.httpStatus).toBe(200);
    expect(result.seed.contentType ?? "").toContain("text/html");
    expect(result.seed.error).toBeNull();

    // Sitemap probe: total 5 URLs declared in sitemap, but only `/seed`
    // matches the seed-prefix scope (the other 4 are at sibling paths
    // /about, /contact, /news, /team). Confirms scope filtering applies
    // to sitemap-mode discovery too.
    expect(result.sitemap.found).toBe(true);
    expect(result.sitemap.totalUrlsInSitemap).toBe(5);
    expect(result.sitemap.urlCount).toBe(1);
    expect(result.sitemap.locations.some((loc) => loc.endsWith("/sitemap.xml"))).toBe(true);

    // Sample crawl actually fetched the seed + discovered linked URLs
    expect(result.sampleCrawl.pagesFetched).toBeGreaterThanOrEqual(1);
    expect(result.sampleCrawl.urlsDiscovered).toBeGreaterThanOrEqual(3);
    expect(result.sampleCrawl.sampleUrls.every((url) => !url.includes("/loggain"))).toBe(true);
    expect(result.sampleCrawl.hitCap).toBe(false);

    // robots.txt parsed (fixture server allows all + advertises /sitemap.xml)
    expect(result.robotsTxt.found).toBe(true);
    expect(result.robotsTxt.fetched).toBe(true);
    expect(result.robotsTxt.allowsSeed).toBe(true);
    expect(result.robotsTxt.declaredSitemaps.length).toBeGreaterThanOrEqual(1);

    // Happy path → no hard warnings
    expect(result.warnings).not.toContain("robots_txt_disallows_seed");
    expect(result.warnings).not.toContain("no_pages_discovered");
  });

  it("flags an unreachable seed with explicit warnings, doesn't hang", async () => {
    const result = await previewCrawlSource({
      url: "http://127.0.0.1:1/never-here",
      crawlType: "crawl",
      depth: 0,
      maxSampleFetches: 5,
    });

    expect(result.seed.reachable).toBe(false);
    expect(result.seed.httpStatus).toBeNull();
    expect(result.seed.error).not.toBeNull();

    expect(result.sampleCrawl.pagesFetched).toBe(0);
    expect(result.sitemap.found).toBe(false);

    expect(result.warnings).toContain("seed_unreachable_network_error");
    expect(result.warnings).toContain("no_pages_discovered");
  });
});
