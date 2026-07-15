// SPDX-License-Identifier: AGPL-3.0-only
/**
 * extractContent — focus on image URL handling. Crawled content embeds image
 * URLs as-is (no download); relative `src` values must be expanded to absolute
 * against the page URL in BOTH the Readability and the cheerio-fallback paths.
 */
import { describe, expect, it } from "vitest";
import { extractContent } from "../extract";

const PAGE_URL = "https://site.example.org/docs/guide.html";
const imgLines = (md: string) =>
  md
    .split("\n")
    .filter((l) => l.includes("!["))
    .join(" ");

// Enough prose to clear the Readability min-chars threshold.
const filler = "This is the main article body with enough text to satisfy readability. ".repeat(8);

describe("extractContent image URLs", () => {
  it("absolutizes relative image src in the fallback path (short page)", () => {
    const html = `<html><body>
      <img alt="rel" src="images/diagram.png">
      <img alt="root" src="/static/logo.png">
      <img alt="abs" src="https://cdn.example.com/a.png">
      <p>tiny</p>
    </body></html>`;
    const { markdown, readabilityUsed } = extractContent(html, PAGE_URL);
    expect(readabilityUsed).toBe(false);
    const imgs = imgLines(markdown);
    expect(imgs).toContain("![rel](https://site.example.org/docs/images/diagram.png)");
    expect(imgs).toContain("![root](https://site.example.org/static/logo.png)");
    expect(imgs).toContain("![abs](https://cdn.example.com/a.png)");
  });

  it("absolutizes relative image src in the Readability path (long page)", () => {
    const html = `<html><body><article><h1>Guide</h1><p>${filler}</p>
      <img alt="rel" src="images/diagram.png">
      <p>${filler}</p></article></body></html>`;
    const { markdown, readabilityUsed } = extractContent(html, PAGE_URL);
    expect(readabilityUsed).toBe(true);
    expect(imgLines(markdown)).toContain(
      "![rel](https://site.example.org/docs/images/diagram.png)",
    );
  });

  it("leaves data: image URIs untouched in the fallback path", () => {
    const html = `<html><body>
      <img alt="inline" src="data:image/png;base64,AAAA">
      <p>tiny</p>
    </body></html>`;
    const { markdown } = extractContent(html, PAGE_URL);
    expect(imgLines(markdown)).toContain("data:image/png;base64,AAAA");
  });
});
