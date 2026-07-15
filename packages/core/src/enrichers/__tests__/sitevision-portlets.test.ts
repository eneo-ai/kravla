// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import sitevisionPortlets from "../sitevision-portlets";

function run(html: string, url = "https://example.test/page") {
  const $ = cheerio.load(html);
  return sitevisionPortlets.enrich({ $, url });
}

describe("sitevision-portlets enricher", () => {
  it("no-ops on pages without any sv-*-portlet markers", () => {
    expect(run('<html><body><div class="article">just content</div></body></html>')).toBeNull();
  });

  it("does NOT flag pages just because sv-archive-portlet is in the layout", () => {
    // The Sitevision news-archive widget sits in the global sidebar of
    // most municipal sites; treating its presence as "this is an archive
    // page" fired on every homepage. Behaviour kept here as a regression
    // guard against re-adding the flag.
    const out = run(`
      <html><body>
        <main><h1>News article</h1><p>body</p></main>
        <aside><section class="sv-archive-portlet"><a href="/x">recent item</a></section></aside>
      </body></html>`);
    expect(out?.metadata.sitevision).toBeUndefined();
  });

  it("extracts related URLs and resolves them against the page URL", () => {
    const out = run(
      `<html><body>
        <section class="sv-text-portlet">main</section>
        <section class="sv-related-portlet">
          <a href="/foo">foo</a>
          <a href="https://other.example/bar">bar</a>
          <a href="#skip">skip-fragment</a>
        </section>
      </body></html>`,
      "https://muni.se/topic/",
    );
    expect((out?.metadata.sitevision as { relatedUrls?: string[] }).relatedUrls).toEqual([
      "https://muni.se/foo",
      "https://other.example/bar",
    ]);
  });

  it("extracts TOC sections with anchors and titles", () => {
    const out = run(`
      <html><body>
        <section class="sv-toc-portlet">
          <ul>
            <li><a href="#avsnitt-1">Avsnitt 1</a></li>
            <li><a href="#avsnitt-2">Avsnitt 2</a></li>
            <li><a href="/elsewhere">skip — not an in-page anchor</a></li>
          </ul>
        </section>
      </body></html>`);
    expect((out?.metadata.sitevision as { tocSections?: unknown }).tocSections).toEqual([
      { title: "Avsnitt 1", anchor: "#avsnitt-1" },
      { title: "Avsnitt 2", anchor: "#avsnitt-2" },
    ]);
  });

  it("turns Sitevision contact-app cards into label:value extraChunks", () => {
    const out = run(`
      <html><body>
        <section class="sv-text-portlet">page body</section>
        <div class="contact" data-cid="abc-1">
          <p class="contact-title">TELEFON</p>
          <a class="contact-data" href="tel:0589-870 00">0589-870 00</a>
        </div>
        <div class="contact" data-cid="abc-2">
          <p class="contact-title">POSTADRESS</p>
          <p class="contact-data">Arboga kommun<br>Box 45<br>732 21 Arboga</p>
        </div>
      </body></html>`);
    expect(out?.extraChunks).toEqual([
      "Contact telefon: 0589-870 00",
      "Contact postadress: Arboga kommun Box 45 732 21 Arboga",
    ]);
  });

  it("turns legacy sv-contact2-portlet cards into name + tel + email chunks", () => {
    const out = run(`
      <html><body>
        <section class="sv-contact2-portlet">
          <h3>Anna Andersson</h3>
          <div class="role">Handläggare</div>
          <a href="tel:0589123">0589 123</a>
          <a href="mailto:anna@arboga.se">anna@arboga.se</a>
        </section>
      </body></html>`);
    expect(out?.extraChunks).toContain(
      "Contact: Anna Andersson, Handläggare, tel 0589 123, email anna@arboga.se",
    );
  });

  it("dedupes identical contact chunks from repeated cards", () => {
    const out = run(`
      <html><body>
        <section class="sv-template-portlet">x</section>
        <div class="contact" data-cid="a"><p class="contact-title">EMAIL</p><a class="contact-data" href="mailto:x@y.se">x@y.se</a></div>
        <div class="contact" data-cid="b"><p class="contact-title">EMAIL</p><a class="contact-data" href="mailto:x@y.se">x@y.se</a></div>
      </body></html>`);
    expect(out?.extraChunks).toEqual(["Contact email: x@y.se"]);
  });

  it("returns null when sv-template-portlet is the only marker and yields nothing useful", () => {
    expect(
      run(`<section class="sv-template-portlet">just a layout container</section>`),
    ).toBeNull();
  });
});
