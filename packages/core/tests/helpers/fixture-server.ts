// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Spawns a localhost HTTP server returning fixture HTML so tests can drive
 * Crawlee against a known input without hitting the real network. The
 * returned `url` is what callers feed into `CrawlSource.url`.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

export type Fixture = {
  /** Path relative to the server root, e.g. "/page-a". */
  path: string;
  title: string;
  bodyHtml: string;
  /** Override the response Content-Type. Defaults to HTML. */
  contentType?: string;
  /** Raw response body. When omitted, bodyHtml is wrapped in an HTML shell. */
  rawBody?: string;
  /** ETag to return in the response header. */
  etag?: string;
  /** Override the response status code (e.g. 401/403 to simulate auth-gated links). Defaults to 200. */
  status?: number;
};

export type SitemapEntry = {
  path: string;
  lastmod?: string;
};

export type FixtureServerOptions = {
  /** Paths to include in `/sitemap.xml`. Resolved against the server URL. */
  sitemapPaths?: string[];
  /** Sitemap entries with optional lastmod. Takes precedence over sitemapPaths. */
  sitemapEntries?: SitemapEntry[];
  /** Additional sitemap URL to advertise in robots.txt (otherwise just the default `/sitemap.xml`). */
  advertiseSitemap?: boolean;
  /** Override `/robots.txt`; set to null to make the fixture return 404. */
  robotsTxt?: string | null;
};

export type FixtureServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
  /** Replace fixtures at runtime (e.g. between crawl runs). */
  setFixtures: (fixtures: Fixture[]) => void;
  /** Replace sitemap entries at runtime (e.g. to add lastmod or new URLs). */
  setSitemapEntries: (entries: SitemapEntry[]) => void;
};

export async function startFixtureServer(
  fixtures: Fixture[],
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  let map = new Map<string, Fixture>();
  for (const f of fixtures) map.set(f.path, f);

  const advertiseSitemap = options.advertiseSitemap ?? false;
  const robotsTxt = options.robotsTxt;
  let currentSitemapEntries: SitemapEntry[] | null = options.sitemapEntries ?? null;
  const sitemapPaths = options.sitemapPaths ?? [];

  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";

    if (path === "/robots.txt") {
      if (robotsTxt === null) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      let body = robotsTxt ?? "User-agent: *\nAllow: /\n";
      if (advertiseSitemap) {
        const port = (server.address() as AddressInfo).port;
        if (!body.endsWith("\n")) body += "\n";
        body += `Sitemap: http://127.0.0.1:${port}/sitemap.xml\n`;
      }
      res.end(body);
      return;
    }

    if (path === "/sitemap.xml") {
      const port = (server.address() as AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;

      let urlElements: string[];
      if (currentSitemapEntries) {
        urlElements = currentSitemapEntries.map((e) => {
          const lastmod = e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : "";
          return `  <url><loc>${origin}${e.path}</loc>${lastmod}</url>`;
        });
      } else {
        const paths = sitemapPaths.length > 0 ? sitemapPaths : Array.from(map.keys());
        urlElements = paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`);
      }

      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urlElements.join("\n") +
        "\n</urlset>";
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    const f = map.get(path);
    if (!f) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    if (f.etag && req.headers["if-none-match"] === f.etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": f.contentType ?? "text/html; charset=utf-8",
    };
    if (f.etag) headers["ETag"] = f.etag;
    res.writeHead(f.status ?? 200, headers);
    res.end(
      f.rawBody ??
        `<!doctype html><html><head><title>${f.title}</title></head><body>${f.bodyHtml}</body></html>`,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    setFixtures(newFixtures: Fixture[]) {
      map = new Map<string, Fixture>();
      for (const f of newFixtures) map.set(f.path, f);
    },
    setSitemapEntries(entries: SitemapEntry[]) {
      currentSitemapEntries = entries;
    },
  };
}
