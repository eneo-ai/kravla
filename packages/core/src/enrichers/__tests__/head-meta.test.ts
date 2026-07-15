// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import headMeta from "../head-meta";

function run(html: string, url = "https://example.test/page") {
  const $ = cheerio.load(html);
  return headMeta.enrich({ $, url });
}

describe("head-meta enricher", () => {
  it("returns null when the head has nothing useful", () => {
    expect(run("<html><head><title>x</title></head><body>hi</body></html>")).toBeNull();
  });

  it("extracts canonical, OpenGraph, article, dcterms, and pageid in one pass", () => {
    const html = `
      <html><head>
        <link rel="canonical" href="/canonical-path">
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Desc">
        <meta property="og:image" content="https://cdn/img.jpg">
        <meta property="og:site_name" content="Borås kommun">
        <meta property="article:published_time" content="2026-05-20T08:00:00Z">
        <meta property="article:modified_time" content="2026-05-21T09:00:00Z">
        <meta property="article:section" content="Nyheter">
        <meta property="article:tag" content="bygglov">
        <meta property="article:tag" content="sommar">
        <meta name="dcterms.identifier" content="sv-123-456">
        <meta name="dcterms.language" content="sv">
        <meta name="pageid" content="42">
        <meta name="keywords" content="bygglov, sommar, ansökan">
        <meta name="robots" content="INDEX,FOLLOW">
      </head></html>`;
    const out = run(html, "https://example.test/articles/foo");
    expect(out).not.toBeNull();
    expect(out?.metadata.canonicalUrl).toBe("https://example.test/canonical-path");
    expect(out?.metadata.og).toMatchObject({
      title: "OG Title",
      description: "OG Desc",
      image: "https://cdn/img.jpg",
      siteName: "Borås kommun",
    });
    expect(out?.metadata.article).toMatchObject({
      publishedAt: "2026-05-20T08:00:00Z",
      modifiedAt: "2026-05-21T09:00:00Z",
      section: "Nyheter",
      tags: ["bygglov", "sommar"],
    });
    expect(out?.metadata.dcterms).toMatchObject({ identifier: "sv-123-456", language: "sv" });
    expect(out?.metadata.pageId).toBe("42");
    expect(out?.metadata.keywords).toEqual(["bygglov", "sommar", "ansökan"]);
    expect(out?.metadata.robots).toBe("index,follow");
    expect(out?.extraChunks).toEqual([]);
  });

  it("falls back to og:updated_time when article:modified_time is absent", () => {
    const html = `<html><head>
      <meta property="og:updated_time" content="2026-05-22T00:00:00Z">
    </head></html>`;
    const out = run(html);
    expect((out?.metadata.article as { modifiedAt?: string }).modifiedAt).toBe(
      "2026-05-22T00:00:00Z",
    );
  });

  it("falls back to the raw href when the URL constructor rejects it", () => {
    // `://broken` and similar inputs the WHATWG URL parser is lenient
    // about would be silently resolved against the page URL — that's
    // fine, not a malformation. To exercise the catch branch we need
    // an input the parser actually rejects (unmatched IPv6 bracket
    // qualifies in Node).
    const html = `<html><head><link rel="canonical" href="http://[::1"></head></html>`;
    const out = run(html);
    expect(out?.metadata.canonicalUrl).toBe("http://[::1");
  });
});
