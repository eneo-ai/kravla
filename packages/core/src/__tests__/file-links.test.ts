// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { fileLinkForUrl, isNonHtmlUrl } from "../file-links";

describe("crawler URL type filter", () => {
  it("keeps dotted HTML-like routes crawlable", () => {
    expect(isNonHtmlUrl("https://example.test/press.release")).toBe(false);
    expect(isNonHtmlUrl("https://example.test/news/2026.05.27")).toBe(false);
    expect(isNonHtmlUrl("https://example.test/about.v2?preview=1")).toBe(false);
  });

  it("filters known non-HTML assets", () => {
    expect(isNonHtmlUrl("https://example.test/files/report.pdf")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/files/minutes.docx")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/assets/logo.svg")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/assets/source.psd")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/assets/app.css")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/assets/app.js")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/data/feed.json")).toBe(true);
  });

  it("still treats tabular files as non-HTML (never fetched as pages)", () => {
    expect(isNonHtmlUrl("https://example.test/data/statistik.csv")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/data/rapport.xlsx")).toBe(true);
  });

  it("filters WebDAV HTML document exports", () => {
    expect(
      isNonHtmlUrl(
        "https://example.test/webdav/files/DOKUMENT/oversiktsplan/Hallbarhetsbedomning.htm",
      ),
    ).toBe(true);
    expect(isNonHtmlUrl("https://example.test/webdav/files/archive/report.html")).toBe(true);
    expect(isNonHtmlUrl("https://example.test/regular/page.html")).toBe(false);
  });
});

describe("fileLinkForUrl", () => {
  it("maps document extensions to their MIME types", () => {
    expect(fileLinkForUrl("https://example.test/files/report.pdf")?.mimeType).toBe(
      "application/pdf",
    );
    expect(fileLinkForUrl("https://example.test/files/notes.md")?.mimeType).toBe("text/markdown");
  });

  it("reports tabular extensions only when the caller opts in (consumer back-compat)", () => {
    // Default: no new link kinds — existing consumers (e.g. Eneo via the
    // kravla service) see identical behavior.
    expect(fileLinkForUrl("https://example.test/data/statistik.csv")).toBeNull();
    expect(fileLinkForUrl("https://example.test/data/rapport.xlsx")).toBeNull();

    const opts = { includeTabular: true };
    expect(
      fileLinkForUrl("https://example.test/data/statistik.csv", undefined, opts)?.mimeType,
    ).toBe("text/csv");
    expect(
      fileLinkForUrl("https://example.test/data/rapport.xlsx", undefined, opts)?.mimeType,
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // Legacy .xls stays unmapped even with the opt-in.
    expect(fileLinkForUrl("https://example.test/data/gammal.xls", undefined, opts)).toBeNull();
  });
});
