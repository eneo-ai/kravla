// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scope-resolution tests, centered on the legacy-Eneo seed convention:
 * sitemap sources stored with the sitemap document itself as the seed
 * (`https://host/sitemap.xml`). Such a seed must widen to site-root scope —
 * page URLs never live under the sitemap's own path, so seed-prefix scope
 * would silently drop every entry.
 */
import { describe, expect, it } from "vitest";
import { isInSeedScope, sitemapSeedScopeUrl } from "../scope";

describe("sitemapSeedScopeUrl", () => {
  it("leaves a site-root seed unchanged", () => {
    expect(sitemapSeedScopeUrl("https://host.se/")).toBe("https://host.se/");
    expect(sitemapSeedScopeUrl("https://host.se")).toBe("https://host.se");
  });

  it("widens a seed naming an XML document to the site root (legacy Eneo seeds)", () => {
    expect(sitemapSeedScopeUrl("https://host.se/sitemap.xml")).toBe("https://host.se/");
    expect(sitemapSeedScopeUrl("https://host.se/sv/sitemapindex.xml")).toBe("https://host.se/");
    expect(sitemapSeedScopeUrl("https://host.se/sitemap.xml.gz")).toBe("https://host.se/");
  });

  it("widens a seed that matches a discovered sitemap location", () => {
    // Extension-less robots-declared location: only the discovered-locations
    // arm can recognize it.
    expect(
      sitemapSeedScopeUrl("https://host.se/custom/sitemap", ["https://host.se/custom/sitemap"]),
    ).toBe("https://host.se/");
  });

  it("matches locations across scheme and trailing-slash differences", () => {
    expect(
      sitemapSeedScopeUrl("https://host.se/custom/sitemap/", ["http://host.se/custom/sitemap"]),
    ).toBe("https://host.se/");
  });

  it("distinguishes locations by query string (Arena/Liferay layout indices)", () => {
    const seed = "https://host.se/sitemap?p_l_id=74";
    expect(sitemapSeedScopeUrl(seed, ["https://host.se/sitemap?p_l_id=74"])).toBe(
      "https://host.se/",
    );
    expect(sitemapSeedScopeUrl(seed, ["https://host.se/sitemap?p_l_id=99"])).toBe(seed);
  });

  it("keeps an ordinary path-prefix seed unchanged", () => {
    expect(sitemapSeedScopeUrl("https://host.se/upplev")).toBe("https://host.se/upplev");
    expect(sitemapSeedScopeUrl("https://host.se/upplev", ["https://host.se/sitemap.xml"])).toBe(
      "https://host.se/upplev",
    );
  });

  it("ignores locations on a different hostname", () => {
    expect(
      sitemapSeedScopeUrl("https://host.se/custom/sitemap", ["https://other.se/custom/sitemap"]),
    ).toBe("https://host.se/custom/sitemap");
  });

  it("returns invalid input verbatim", () => {
    expect(sitemapSeedScopeUrl("not a url")).toBe("not a url");
  });

  it("the widened seed puts the whole site in scope", () => {
    const scope = sitemapSeedScopeUrl("https://host.se/sitemap.xml");
    expect(isInSeedScope(scope, "https://host.se/kommun/kontakt")).toBe(true);
    // ...while the raw legacy seed would have dropped it.
    expect(isInSeedScope("https://host.se/sitemap.xml", "https://host.se/kommun/kontakt")).toBe(
      false,
    );
  });
});
