// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCrawl } from "../../src/crawl-runner";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer([
    {
      path: "/",
      title: "Root",
      bodyHtml:
        '<a href="/a">A</a><a href="/outside">Outside</a><a href="/login">Login</a><a href="/loggain?redirect=%2Fstatistik%2Ffamily%2F211%3Ftriggerlogin%3D1">Loggain</a>',
    },
    { path: "/a", title: "A", bodyHtml: '<a href="/a/b">B</a><a href="/outside">Outside</a>' },
    { path: "/a/b", title: "B", bodyHtml: '<a href="/a/b/c">C</a>' },
    { path: "/a/b/c", title: "C", bodyHtml: "<p>C</p>" },
    { path: "/outside", title: "Outside", bodyHtml: "<p>Outside</p>" },
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("crawl depth", () => {
  it.each([
    [0, ["/"]],
    [1, ["/", "/a", "/outside"]],
    [2, ["/", "/a", "/a/b", "/outside"]],
  ])("limits crawl depth to %i", async (depth, expectedPaths) => {
    const visited: string[] = [];
    const outcome = await runCrawl({
      seedUrl: server.url,
      crawlType: "crawl",
      depth,
      maxRequestsPerMinute: 600,
      onPage: async (page) => {
        visited.push(new URL(page.url).pathname);
      },
    });

    expect(visited.sort()).toEqual(expectedPaths);
    expect(outcome.failedCount).toBe(0);
  });

  it("can crawl the whole URL path prefix without a depth limit", async () => {
    const visited: string[] = [];
    await runCrawl({
      seedUrl: `${server.url}/a`,
      crawlType: "crawl",
      depth: 0,
      crawlScope: "path_prefix",
      maxRequestsPerMinute: 600,
      onPage: async (page) => {
        visited.push(new URL(page.url).pathname);
      },
    });

    expect(visited.sort()).toEqual(["/a", "/a/b", "/a/b/c"]);
  });

  it("skips robots-blocked discovered URLs visibly", async () => {
    const robotsServer = await startFixtureServer(
      [
        {
          path: "/",
          title: "Root",
          bodyHtml: '<a href="/allowed">Allowed</a><a href="/blocked">Blocked</a>',
        },
        { path: "/allowed", title: "Allowed", bodyHtml: "<p>Allowed</p>" },
        { path: "/blocked", title: "Blocked", bodyHtml: "<p>Blocked</p>" },
      ],
      { robotsTxt: "User-agent: *\nDisallow: /blocked\n" },
    );
    try {
      const visited: string[] = [];
      const skipped: string[] = [];
      const outcome = await runCrawl({
        seedUrl: robotsServer.url,
        crawlType: "crawl",
        depth: 1,
        maxRequestsPerMinute: 600,
        onPage: async (page) => {
          visited.push(new URL(page.url).pathname);
        },
        onSkippedRobots: async (page) => {
          skipped.push(new URL(page.url).pathname);
        },
      });

      expect(visited.sort()).toEqual(["/", "/allowed"]);
      expect(skipped).toEqual(["/blocked"]);
      expect(outcome.skippedRobotsCount).toBe(1);
      expect(outcome.failedCount).toBe(0);
    } finally {
      await robotsServer.close();
    }
  });

  it("records auth-gated/gone discovered links as skipped, not failed, without retrying", async () => {
    const gatedServer = await startFixtureServer([
      {
        path: "/",
        title: "Root",
        bodyHtml:
          '<a href="/ok">OK</a><a href="/gated">Gated</a><a href="/forbidden">Forbidden</a><a href="/gone">Gone</a>',
      },
      { path: "/ok", title: "OK", bodyHtml: "<p>OK</p>" },
      { path: "/gated", title: "Gated", bodyHtml: "<p>Login required</p>", status: 401 },
      { path: "/forbidden", title: "Forbidden", bodyHtml: "<p>Nope</p>", status: 403 },
      // `/gone` is intentionally absent from the fixture map → 404.
    ]);
    try {
      const visited: string[] = [];
      const failed: string[] = [];
      const skippedUnavailable: { path: string; httpStatus: number }[] = [];
      const outcome = await runCrawl({
        seedUrl: gatedServer.url,
        crawlType: "crawl",
        depth: 1,
        maxRequestsPerMinute: 600,
        onPage: async (page) => {
          visited.push(new URL(page.url).pathname);
        },
        onFailed: async (failure) => {
          failed.push(new URL(failure.url).pathname);
        },
        onSkippedUnavailable: async (s) => {
          skippedUnavailable.push({ path: new URL(s.url).pathname, httpStatus: s.httpStatus });
        },
      });

      expect(visited.sort()).toEqual(["/", "/ok"]);
      expect(failed).toEqual([]);
      expect(outcome.failedCount).toBe(0);
      expect(outcome.skippedUnavailableCount).toBe(3);
      expect(skippedUnavailable.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "/forbidden", httpStatus: 403 },
        { path: "/gated", httpStatus: 401 },
        { path: "/gone", httpStatus: 404 },
      ]);
    } finally {
      await gatedServer.close();
    }
  });

  it("treats no-extension CSV responses as skipped content, not failed retries", async () => {
    const csvServer = await startFixtureServer([
      {
        path: "/",
        title: "Root",
        bodyHtml: '<a href="/statistik/ratings/136">CSV</a>',
      },
      {
        path: "/statistik/ratings/136",
        title: "CSV",
        bodyHtml: "",
        contentType: "text/csv; charset=utf-8",
        rawBody: "name,count\nstarted,12\n",
      },
    ]);
    try {
      const visited: string[] = [];
      const failed: string[] = [];
      const outcome = await runCrawl({
        seedUrl: csvServer.url,
        crawlType: "crawl",
        depth: 1,
        maxRequestsPerMinute: 600,
        onPage: async (page) => {
          visited.push(new URL(page.url).pathname);
        },
        onFailed: async (failure) => {
          failed.push(new URL(failure.url).pathname);
        },
      });

      expect(visited).toEqual(["/"]);
      expect(failed).toEqual([]);
      expect(outcome.failedCount).toBe(0);
      expect(outcome.skippedByContentType).toBe(1);
    } finally {
      await csvServer.close();
    }
  });
});
