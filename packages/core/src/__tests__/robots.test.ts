// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  buildRobotsSnapshot,
  effectiveMaxRequestsPerMinute,
  loadRobotsPolicyForUrl,
} from "../robots";

describe("robots policy", () => {
  it("allows crawling when robots.txt is missing", async () => {
    const policy = await loadRobotsPolicyForUrl(
      "https://example.test/start",
      async () => new Response("not found", { status: 404 }),
    );

    expect(policy.found).toBe(false);
    expect(policy.allows("https://example.test/private")).toBe(true);
  });

  it("honors longest allow/disallow rules", async () => {
    const body = [
      "User-agent: *",
      "Disallow: /private",
      "Allow: /private/public",
      "Crawl-delay: 3",
      "Sitemap: https://example.test/sitemap.xml",
      "",
    ].join("\n");
    const policy = await loadRobotsPolicyForUrl(
      "https://example.test/start",
      async () => new Response(body, { status: 200 }),
    );

    expect(policy.found).toBe(true);
    expect(policy.fetched).toBe(true);
    expect(policy.allows("https://example.test/private/secret")).toBe(false);
    expect(policy.allows("https://example.test/private/public/info")).toBe(true);
    expect(policy.crawlDelaySeconds).toBe(3);
    expect(policy.declaredSitemaps).toEqual(["https://example.test/sitemap.xml"]);
  });

  it("caps crawl rate using crawl-delay without raising the configured rate", () => {
    expect(effectiveMaxRequestsPerMinute(60, 10)).toBe(6);
    expect(effectiveMaxRequestsPerMinute(5, 10)).toBe(5);
    expect(effectiveMaxRequestsPerMinute(60, 120)).toBe(1);
    expect(effectiveMaxRequestsPerMinute(60, null)).toBe(60);
  });

  it("builds a serializable snapshot collapsing allows() to the seed", async () => {
    const body = [
      "User-agent: *",
      "Disallow: /private",
      "Crawl-delay: 3",
      "Sitemap: https://example.test/sitemap.xml",
      "",
    ].join("\n");
    const policy = await loadRobotsPolicyForUrl(
      "https://example.test/private/page",
      async () => new Response(body, { status: 200 }),
    );

    const snapshot = buildRobotsSnapshot(policy, "https://example.test/private/page");
    expect(snapshot.found).toBe(true);
    expect(snapshot.fetched).toBe(true);
    expect(snapshot.seedAllowed).toBe(false);
    expect(snapshot.crawlDelaySeconds).toBe(3);
    expect(snapshot.declaredSitemaps).toEqual(["https://example.test/sitemap.xml"]);
    expect(typeof snapshot.fetchedAt).toBe("string");
    expect(Number.isNaN(Date.parse(snapshot.fetchedAt))).toBe(false);
  });
});
