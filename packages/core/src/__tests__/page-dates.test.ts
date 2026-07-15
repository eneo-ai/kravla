// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import { resolvePageDates, toIsoDate } from "../page-dates";

describe("toIsoDate", () => {
  it("normalizes full ISO timestamps to UTC", () => {
    expect(toIsoDate("2026-05-20T08:00:00Z")).toBe("2026-05-20T08:00:00.000Z");
    expect(toIsoDate("2026-05-20T10:00:00+02:00")).toBe("2026-05-20T08:00:00.000Z");
  });

  it("normalizes date-only inputs to UTC midnight", () => {
    expect(toIsoDate("2026-05-20")).toBe("2026-05-20T00:00:00.000Z");
  });

  it("rejects non-strings, empties, and unparseable values", () => {
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate(1747728000000)).toBeNull();
    expect(toIsoDate("")).toBeNull();
    expect(toIsoDate("   ")).toBeNull();
    expect(toIsoDate("igår")).toBeNull();
  });

  it("rejects dates outside the sanity window", () => {
    expect(toIsoDate("1970-01-01T00:00:00Z")).toBeNull();
    expect(toIsoDate("1989-12-31")).toBeNull();
    expect(toIsoDate("3000-01-01")).toBeNull();
    // Within the 36 h future-skew tolerance is fine.
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(toIsoDate(soon)).toBe(soon);
  });
});

describe("resolvePageDates", () => {
  it("returns nulls and null dateSources when nothing is present", () => {
    expect(resolvePageDates({ metadata: null })).toEqual({
      publishedAt: null,
      modifiedAt: null,
      dateSources: null,
    });
    expect(resolvePageDates({ metadata: {} }).dateSources).toBeNull();
  });

  it("prefers JSON-LD over article meta over dcterms", () => {
    const out = resolvePageDates({
      metadata: {
        jsonLd: { article: { publishedAt: "2026-01-01", modifiedAt: "2026-01-05" } },
        article: { publishedAt: "2026-02-01", modifiedAt: "2026-02-05" },
        dcterms: { issued: "2026-03-01", modified: "2026-03-05" },
      },
    });
    expect(out.publishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(out.modifiedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(out.dateSources).toEqual({ publishedAt: "json-ld", modifiedAt: "json-ld" });
  });

  it("skips an invalid higher-priority value and takes the next valid one", () => {
    const out = resolvePageDates({
      metadata: {
        jsonLd: { article: { publishedAt: "not-a-date" } },
        article: { publishedAt: "2026-02-01T10:00:00Z" },
      },
    });
    expect(out.publishedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(out.dateSources).toEqual({ publishedAt: "meta-article" });
  });

  it("falls through dcterms issued → created → date for publishedAt", () => {
    expect(resolvePageDates({ metadata: { dcterms: { created: "2026-04-01" } } }).publishedAt).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(resolvePageDates({ metadata: { dcterms: { date: "2026-04-02" } } }).publishedAt).toBe(
      "2026-04-02T00:00:00.000Z",
    );
    const out = resolvePageDates({
      metadata: { dcterms: { issued: "2026-04-01", created: "2026-04-09", date: "2026-04-10" } },
    });
    expect(out.publishedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(out.dateSources?.publishedAt).toBe("dcterms");
  });

  it("uses <time> element values when head metadata is absent", () => {
    const out = resolvePageDates({
      metadata: { time: { publishedAt: "2026-05-01T08:00:00Z", modifiedAt: "2026-05-02" } },
    });
    expect(out.publishedAt).toBe("2026-05-01T08:00:00.000Z");
    expect(out.modifiedAt).toBe("2026-05-02T00:00:00.000Z");
    expect(out.dateSources).toEqual({ publishedAt: "time-element", modifiedAt: "time-element" });
  });

  it("uses sitemap lastmod as the last resort for modifiedAt only", () => {
    const out = resolvePageDates({ metadata: {}, sitemapLastmod: "2026-05-10T00:00:00.000Z" });
    expect(out.modifiedAt).toBe("2026-05-10T00:00:00.000Z");
    expect(out.publishedAt).toBeNull();
    expect(out.dateSources).toEqual({ modifiedAt: "sitemap-lastmod" });
  });

  it("lets a content-level signal beat sitemap lastmod", () => {
    const out = resolvePageDates({
      metadata: { article: { modifiedAt: "2026-05-01" } },
      sitemapLastmod: "2026-05-10",
    });
    expect(out.modifiedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(out.dateSources?.modifiedAt).toBe("meta-article");
  });

  it("resolves the two fields independently from different sources", () => {
    const out = resolvePageDates({
      metadata: { dcterms: { issued: "2026-01-01" } },
      sitemapLastmod: "2026-06-01",
    });
    expect(out.dateSources).toEqual({ publishedAt: "dcterms", modifiedAt: "sitemap-lastmod" });
  });

  it("never reads HTTP Last-Modified shaped input — there is no such source", () => {
    // The resolver's only inputs are enricher metadata + sitemapLastmod;
    // a stray lastModified key in metadata is ignored by construction.
    const out = resolvePageDates({ metadata: { lastModified: "2026-05-01T00:00:00Z" } });
    expect(out.modifiedAt).toBeNull();
    expect(out.dateSources).toBeNull();
  });
});
