// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { isExcludedCrawlUrl, normalizeExcludeUrlPatterns } from "../url-exclusions";

describe("common crawl URL exclusions", () => {
  it.each([
    "https://example.test/loggain?redirect=%2Fstatistik%2Ffamily%2F211%3Ftriggerlogin%3D1",
    "https://example.test/login",
    "https://example.test/login?next=%2Fservice",
    "https://example.test/logout",
    "https://example.test/sign-in",
    "https://example.test/signout?returnTo=%2F",
    "https://example.test/service?triggerlogin=1",
  ])("excludes auth/navigation noise: %s", (url) => {
    expect(isExcludedCrawlUrl(url)).toBe(true);
  });

  it.each([
    "https://example.test/",
    "https://example.test/statistik/family/211",
    "https://example.test/tjanst/login-som-god-man",
  ])("keeps ordinary content URLs: %s", (url) => {
    expect(isExcludedCrawlUrl(url)).toBe(false);
  });

  it("applies additive operator-provided glob patterns", () => {
    const patterns = ["/search?**", "/calendar/**", "**utm_*"];

    expect(isExcludedCrawlUrl("https://example.test/search?q=permit", patterns)).toBe(true);
    expect(isExcludedCrawlUrl("https://example.test/calendar/2026/may", patterns)).toBe(true);
    expect(isExcludedCrawlUrl("https://example.test/news?utm_source=feed", patterns)).toBe(true);
    expect(isExcludedCrawlUrl("https://example.test/news/ordinary", patterns)).toBe(false);
  });

  it("normalizes empty and duplicate operator patterns", () => {
    expect(normalizeExcludeUrlPatterns(["", " /search?** ", "/search?**"])).toEqual(["/search?**"]);
  });
});
