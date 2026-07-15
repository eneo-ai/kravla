// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import jsonLd from "../json-ld";

function run(html: string, url = "https://example.test/page") {
  const $ = cheerio.load(html);
  return jsonLd.enrich({ $, url });
}

function wrapLd(obj: unknown): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;
}

describe("json-ld enricher", () => {
  it("returns null when no JSON-LD blocks are present", () => {
    expect(run("<html><head></head></html>")).toBeNull();
  });

  it("survives malformed JSON-LD by skipping that block", () => {
    const html = `
      <html><head>
        <script type="application/ld+json">{ this isn't JSON }</script>
        <script type="application/ld+json">${JSON.stringify({
          "@type": "BreadcrumbList",
          itemListElement: [{ "@type": "ListItem", position: 1, name: "Hem" }],
        })}</script>
      </head></html>`;
    const out = run(html);
    expect((out?.metadata.jsonLd as { breadcrumbs?: string[] }).breadcrumbs).toEqual(["Hem"]);
  });

  it("extracts NewsArticle fields", () => {
    const html = wrapLd({
      "@type": "NewsArticle",
      headline: "Snöröjning startar",
      datePublished: "2026-05-20",
      dateModified: "2026-05-21",
      articleSection: "Trafik",
      author: { "@type": "Person", name: "Pressredaktionen" },
    });
    const out = run(html);
    expect((out?.metadata.jsonLd as { article?: Record<string, unknown> }).article).toMatchObject({
      headline: "Snöröjning startar",
      publishedAt: "2026-05-20",
      modifiedAt: "2026-05-21",
      section: "Trafik",
      author: "Pressredaktionen",
    });
  });

  it("orders BreadcrumbList by position even when JSON is out-of-order", () => {
    const html = wrapLd({
      "@type": "BreadcrumbList",
      itemListElement: [
        { position: 3, name: "Snöröjning" },
        { position: 1, name: "Hem" },
        { position: 2, name: "Trafik" },
      ],
    });
    const out = run(html);
    expect((out?.metadata.jsonLd as { breadcrumbs?: string[] }).breadcrumbs).toEqual([
      "Hem",
      "Trafik",
      "Snöröjning",
    ]);
  });

  it("merges nested @graph nodes and emits one contact chunk per Person", () => {
    const html = wrapLd({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "GovernmentOrganization",
          name: "Borås kommun",
          url: "https://www.boras.se",
        },
        {
          "@type": "Person",
          name: "Anna Andersson",
          jobTitle: "Kommunikatör",
          telephone: "+4633123456",
          email: "anna@boras.se",
        },
        {
          "@type": "ContactPoint",
          contactType: "kundtjänst",
          telephone: "+4633000000",
        },
      ],
    });
    const out = run(html);
    const org = (out?.metadata.jsonLd as { organization?: Record<string, unknown> }).organization;
    expect(org).toMatchObject({ name: "Borås kommun", url: "https://www.boras.se" });
    expect((org as { contactPoints?: unknown[] }).contactPoints).toHaveLength(1);
    expect(out?.extraChunks).toEqual(
      expect.arrayContaining([
        "Contact: Anna Andersson, Kommunikatör, tel +4633123456, email anna@boras.se",
        "Contact: kundtjänst, tel +4633000000",
      ]),
    );
  });

  it("emits one extra chunk per FAQPage question with HTML stripped from the answer", () => {
    const html = wrapLd({
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "När töms soptunnan?",
          acceptedAnswer: { "@type": "Answer", text: "<p>Var <strong>tredje</strong> vecka.</p>" },
        },
      ],
    });
    const out = run(html);
    expect(out?.extraChunks).toEqual(["Q: När töms soptunnan?\nA: Var tredje vecka."]);
  });

  it("extracts Event records with start/end dates and location names", () => {
    const html = wrapLd({
      "@type": "Event",
      name: "Nationaldagen",
      startDate: "2026-06-06",
      location: { "@type": "Place", name: "Stora torget" },
    });
    const out = run(html);
    expect((out?.metadata.jsonLd as { events?: unknown[] }).events).toEqual([
      {
        name: "Nationaldagen",
        startDate: "2026-06-06",
        endDate: undefined,
        location: "Stora torget",
      },
    ]);
  });
});
