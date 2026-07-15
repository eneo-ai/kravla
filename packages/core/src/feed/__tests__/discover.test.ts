// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { extractFeedLink, looksLikeHtml } from "../discover";

describe("feed autodiscovery", () => {
  it("extracts an RSS autodiscovery link, resolved absolute", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS">
    </head><body></body></html>`;
    expect(extractFeedLink(html, "https://example.se/news")).toBe("https://example.se/feed.xml");
  });

  it("extracts an Atom autodiscovery link", () => {
    const html =
      '<head><link rel="alternate" type="application/atom+xml" href="https://x.se/atom"></head>';
    expect(extractFeedLink(html, "https://x.se/")).toBe("https://x.se/atom");
  });

  it("returns null when the page advertises no feed", () => {
    expect(extractFeedLink("<html><head></head><body>hi</body></html>", "https://x.se")).toBeNull();
  });

  it("classifies HTML vs feed by content-type then body sniff", () => {
    expect(looksLikeHtml("text/html; charset=utf-8", "")).toBe(true);
    expect(looksLikeHtml("application/rss+xml", "")).toBe(false);
    expect(looksLikeHtml("text/xml", "<rss></rss>")).toBe(false);
    expect(looksLikeHtml(null, "<!doctype html><html>")).toBe(true);
    expect(looksLikeHtml(null, '<?xml version="1.0"?><rss>')).toBe(false);
  });
});
