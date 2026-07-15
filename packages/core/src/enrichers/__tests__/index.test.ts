// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import { runEnrichers } from "../index";

describe("runEnrichers", () => {
  it("returns metadata=null when nothing was extracted", () => {
    const r = runEnrichers({ html: "<html><body>hi</body></html>", url: "https://x.test/" });
    expect(r.metadata).toBeNull();
    expect(r.extraChunks).toEqual([]);
  });

  it("merges head-meta + json-ld + sitevision + time-elements output without collisions", () => {
    const html = `
      <html><head>
        <link rel="canonical" href="https://muni.se/articles/x">
        <meta property="article:published_time" content="2026-05-20T00:00:00Z">
        <script type="application/ld+json">${JSON.stringify({
          "@type": "BreadcrumbList",
          itemListElement: [
            { position: 1, name: "Hem" },
            { position: 2, name: "Nyheter" },
          ],
        })}</script>
      </head><body>
        <article>
          <p>Senast uppdaterad: <time datetime="2026-05-25">25 maj 2026</time></p>
        </article>
        <section class="sv-related-portlet"><a href="/related-1">related</a></section>
        <div class="contact" data-cid="c">
          <p class="contact-title">TELEFON</p>
          <a class="contact-data" href="tel:0589-870 00">0589-870 00</a>
        </div>
      </body></html>`;
    const r = runEnrichers({ html, url: "https://muni.se/articles/x" });
    expect(r.metadata).toMatchObject({
      canonicalUrl: "https://muni.se/articles/x",
      article: { publishedAt: "2026-05-20T00:00:00Z" },
      jsonLd: { breadcrumbs: ["Hem", "Nyheter"] },
      sitevision: { relatedUrls: ["https://muni.se/related-1"] },
      time: { modifiedAt: "2026-05-25" },
    });
    expect(r.extraChunks).toContain("Contact telefon: 0589-870 00");
  });

  it("dedupes extra chunks across enrichers + truncates to MAX_CHUNK_CHARS", () => {
    const longAnswer = "x".repeat(2000);
    const html = `
      <html><head>
        <script type="application/ld+json">${JSON.stringify({
          "@type": "FAQPage",
          mainEntity: [
            { "@type": "Question", name: "Q1?", acceptedAnswer: { text: longAnswer } },
            { "@type": "Question", name: "Q1?", acceptedAnswer: { text: longAnswer } },
          ],
        })}</script>
      </head></html>`;
    const r = runEnrichers({ html, url: "https://x.test/" });
    expect(r.extraChunks).toHaveLength(1);
    expect(r.extraChunks[0]!.length).toBeLessThanOrEqual(800);
  });

  it("caps metadata bytes by dropping the largest top-level key first", () => {
    // Make sitevision.relatedUrls comfortably exceed the 16 KB cap so it
    // gets dropped before the small canonicalUrl + article fields. URLs
    // use a long deterministic path so we don't have to count bytes
    // precisely — 1000 × ~50-char URLs serialise to ~50 KB.
    const longPath = "long-related-content-path-segment-for-cap-test";
    const links = Array.from(
      { length: 1000 },
      (_, i) => `<a href="/${longPath}/${i}">link${i}</a>`,
    ).join("");
    const html = `
      <html><head>
        <link rel="canonical" href="https://x.test/canonical">
        <meta property="article:published_time" content="2026-05-20T00:00:00Z">
      </head><body>
        <section class="sv-related-portlet">${links}</section>
      </body></html>`;
    const r = runEnrichers({ html, url: "https://x.test/" });
    expect(r.metadata).not.toBeNull();
    expect(r.metadata!.canonicalUrl).toBe("https://x.test/canonical");
    // The big sitevision block should be the one that got dropped.
    expect(r.metadata!.sitevision).toBeUndefined();
  });
});
