// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import timeElements from "../time-elements";

function run(html: string, url = "https://example.test/page") {
  const $ = cheerio.load(html);
  return timeElements.enrich({ $, url });
}

describe("time-elements enricher", () => {
  it("returns null when the page has no time elements", () => {
    expect(run("<html><body><p>hej</p></body></html>")).toBeNull();
  });

  it("takes microdata itemprop dates outright", () => {
    const out = run(`
      <article>
        <time itemprop="datePublished" datetime="2026-05-20T08:00:00Z">20 maj 2026</time>
        <time itemprop="dateModified" datetime="2026-05-21T09:00:00Z">21 maj 2026</time>
      </article>`);
    expect(out?.metadata.time).toEqual({
      publishedAt: "2026-05-20T08:00:00Z",
      modifiedAt: "2026-05-21T09:00:00Z",
    });
  });

  it("classifies labelled byline dates inside <article>, Swedish included", () => {
    const out = run(`
      <article>
        <p>Publicerad: <time datetime="2026-05-20">20 maj 2026</time></p>
        <p>Senast uppdaterad: <time datetime="2026-05-25">25 maj 2026</time></p>
      </article>`);
    expect(out?.metadata.time).toEqual({
      publishedAt: "2026-05-20",
      modifiedAt: "2026-05-25",
    });
  });

  it("defaults a single unlabelled <time> inside <article> to publishedAt", () => {
    const out = run(`
      <article>
        <header><time datetime="2026-05-20T08:00:00Z">20 maj</time></header>
        <p>brödtext</p>
      </article>`);
    expect(out?.metadata.time).toEqual({ publishedAt: "2026-05-20T08:00:00Z" });
  });

  it("classifies labelled dates outside <article> when the page has few time elements", () => {
    const out = run(`
      <body>
        <main>sidinnehåll</main>
        <footer class="page-footer">Sidan granskades <time datetime="2026-05-30">30 maj</time></footer>
      </body>`);
    expect(out?.metadata.time).toEqual({ modifiedAt: "2026-05-30" });
  });

  it("ignores event-listing pages with many unlabelled time elements", () => {
    const items = Array.from(
      { length: 6 },
      (_, i) => `<li><time datetime="2026-07-0${i + 1}">evenemang</time></li>`,
    ).join("");
    expect(run(`<body><ul>${items}</ul></body>`)).toBeNull();
  });

  it("skips unparseable datetime values", () => {
    const out = run(`
      <article>
        <p>Publicerad: <time datetime="igår">igår</time></p>
      </article>`);
    expect(out).toBeNull();
  });

  it("does not let an unlabelled date win when two unclassified candidates exist", () => {
    const out = run(`
      <article>
        <time datetime="2026-05-20">a</time>
        <time datetime="2026-05-21">b</time>
      </article>`);
    expect(out).toBeNull();
  });
});
