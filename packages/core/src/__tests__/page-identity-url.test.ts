// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { normalizeCrawlUrl, resolvePageIdentityUrl } from "../page-identity-url";

describe("normalizeCrawlUrl", () => {
  it("strips tracking params and fragments", () => {
    expect(normalizeCrawlUrl("https://host.se/a?utm_source=nl&utm_medium=email")).toBe(
      "https://host.se/a",
    );
    expect(normalizeCrawlUrl("https://host.se/a?gclid=123&fbclid=456")).toBe("https://host.se/a");
    expect(normalizeCrawlUrl("https://host.se/a#section")).toBe("https://host.se/a");
  });

  it("keeps content-bearing params, dropping only the tracking ones", () => {
    expect(normalizeCrawlUrl("https://host.se/list?page=2&utm_source=nl")).toBe(
      "https://host.se/list?page=2",
    );
    expect(normalizeCrawlUrl("https://host.se/p?id=7&ref=home")).toBe(
      "https://host.se/p?id=7&ref=home",
    );
  });

  it("returns the input unchanged when there is nothing to strip", () => {
    const url = "https://host.se/list?page=2";
    expect(normalizeCrawlUrl(url)).toBe(url);
    expect(normalizeCrawlUrl("https://host.se/a")).toBe("https://host.se/a");
  });

  it("returns unparseable input verbatim", () => {
    expect(normalizeCrawlUrl("not a url")).toBe("not a url");
  });
});

describe("resolvePageIdentityUrl", () => {
  const scopeSeedUrl = "https://www.ri.se/sv/artificiell-intelligens";
  const base = "https://www.ri.se/sv/artificiell-intelligens/artiklar";

  it("collapses pagination onto a same-host in-scope canonical", () => {
    expect(
      resolvePageIdentityUrl({
        fetchedUrl: `${base}?page=3`,
        canonicalUrl: base,
        scopeSeedUrl,
      }),
    ).toBe(base);
  });

  it("normalizes the fetched URL when there is no canonical", () => {
    expect(
      resolvePageIdentityUrl({
        fetchedUrl: `${base}?utm_source=nl`,
        canonicalUrl: null,
        scopeSeedUrl,
      }),
    ).toBe(base);
  });

  it("ignores a cross-host canonical", () => {
    expect(
      resolvePageIdentityUrl({
        fetchedUrl: `${base}?page=2`,
        canonicalUrl: "https://evil.example/landing",
        scopeSeedUrl,
      }),
    ).toBe(`${base}?page=2`);
  });

  it("ignores a canonical outside the seed scope", () => {
    expect(
      resolvePageIdentityUrl({
        fetchedUrl: `${base}?page=2`,
        canonicalUrl: "https://www.ri.se/en/something-else",
        scopeSeedUrl,
      }),
    ).toBe(`${base}?page=2`);
  });

  it("ignores a non-http canonical", () => {
    expect(
      resolvePageIdentityUrl({
        fetchedUrl: base,
        canonicalUrl: "android-app://com.ri/app",
        scopeSeedUrl,
      }),
    ).toBe(base);
  });

  it("still strips tracking params off an honored canonical", () => {
    expect(
      resolvePageIdentityUrl({
        fetchedUrl: `${base}?page=2`,
        canonicalUrl: `${base}?utm_source=cms`,
        scopeSeedUrl,
      }),
    ).toBe(base);
  });
});
