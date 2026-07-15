// SPDX-License-Identifier: AGPL-3.0-only
import type { CheerioAPI } from "cheerio";

export type FileLink = {
  url: string;
  anchorText: string;
  mimeType: string;
};

const EXTENSION_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/**
 * Tabular data files, reported as FileLinks only when the caller opts in
 * (`includeTabular`) — existing consumers see no new link kinds without
 * asking. The consumer decides whether (and how) to ingest them. Legacy .xls
 * is deliberately absent — rare enough to wait for a real ask.
 */
const TABULAR_EXTENSION_TO_MIME: Record<string, string> = {
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export type FileLinkOptions = {
  /** Also report tabular files (csv/xlsx) as FileLinks. Default false. */
  includeTabular?: boolean;
};

function mimeForExtension(ext: string, opts?: FileLinkOptions): string | null {
  return (
    EXTENSION_TO_MIME[ext] ?? (opts?.includeTabular ? TABULAR_EXTENSION_TO_MIME[ext] : null) ?? null
  );
}

export const FILE_EXCLUDE_GLOBS = [
  ...Object.keys(EXTENSION_TO_MIME).map((ext) => `**/*${ext}`),
  "**/webdav/files/**/*.htm",
  "**/webdav/files/**/*.html",
];

const NON_HTML_EXTENSIONS = new Set([
  ...Object.keys(EXTENSION_TO_MIME),
  ...Object.keys(TABULAR_EXTENSION_TO_MIME),
  // Images
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jfif",
  ".jpeg",
  ".jpg",
  ".png",
  ".psd",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
  // Video
  ".avi",
  ".flv",
  ".mkv",
  ".mov",
  ".mp4",
  ".webm",
  ".wmv",
  // Audio
  ".aac",
  ".flac",
  ".mp3",
  ".ogg",
  ".wav",
  ".wma",
  // Archives
  ".7z",
  ".bz2",
  ".gz",
  ".rar",
  ".tar",
  ".zip",
  // Data / config (.csv is covered by TABULAR_EXTENSION_TO_MIME above)
  ".json",
  ".tsv",
  ".xml",
  // Scripts / stylesheets
  ".css",
  ".js",
  ".mjs",
  // Documents (beyond EXTENSION_TO_MIME)
  ".odp",
  ".ods",
  ".odt",
  ".ppt",
  ".pptx",
  ".rtf",
  ".xls",
  // Fonts
  ".eot",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
  // Binaries
  ".deb",
  ".dmg",
  ".exe",
  ".iso",
  ".msi",
  ".rpm",
  // Web manifests / service-worker assets
  ".webmanifest",
]);

/**
 * Build a `FileLink` for a single URL when its extension maps to a
 * supported file type (PDF/DOCX/TXT/MD documents; CSV/XLSX tabular data when
 * `includeTabular` is set), else null. Used by the feed runner to route an
 * entry's non-HTML link target through the same crawled-file ingest path as
 * web crawls.
 */
export function fileLinkForUrl(
  url: string,
  anchorText?: string,
  opts?: FileLinkOptions,
): FileLink | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const ext = pathname.match(/\.[a-z0-9]+$/)?.[0];
  if (!ext) return null;
  const mime = mimeForExtension(ext, opts);
  if (!mime) return null;
  return { url, anchorText: anchorText?.trim() || filenameFromUrl(url), mimeType: mime };
}

export function isNonHtmlUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (isWebdavDocumentExportPath(pathname)) return true;
    const ext = pathname.match(/\.[a-z0-9]+$/)?.[0];
    if (!ext) return false;
    return NON_HTML_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function isWebdavDocumentExportPath(pathname: string): boolean {
  return (
    pathname.startsWith("/webdav/files/") &&
    (pathname.endsWith(".htm") || pathname.endsWith(".html"))
  );
}

/**
 * Extract file links from a crawled page. Scoped to same-hostname only —
 * NOT seed-path scoped, because files typically live under a different path
 * hierarchy than the HTML pages (e.g. `/download/`, `/dokument/`, `/media/`).
 */
export function extractFileLinks(
  $: CheerioAPI,
  pageUrl: string,
  seedUrl: string,
  opts?: FileLinkOptions,
): FileLink[] {
  const seen = new Set<string>();
  const links: FileLink[] = [];

  let seedHostname: string;
  try {
    seedHostname = new URL(seedUrl).hostname;
  } catch {
    return links;
  }

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      return;
    }

    if (resolved.hostname !== seedHostname) return;

    resolved.hash = "";

    const pathname = resolved.pathname.toLowerCase();
    const ext = pathname.match(/\.[a-z0-9]+$/)?.[0];
    if (!ext) return;

    const mime = mimeForExtension(ext, opts);
    if (!mime) return;

    const normalized = resolved.href;
    if (seen.has(normalized)) return;

    seen.add(normalized);
    links.push({
      url: normalized,
      anchorText: filenameFromUrl(normalized),
      mimeType: mime,
    });
  });

  return links;
}

function filenameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (!last) return url;
    const decoded = decodeURIComponent(last);
    return decoded.replace(/\.[^.]+$/, "");
  } catch {
    return url;
  }
}
