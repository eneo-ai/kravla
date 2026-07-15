// SPDX-License-Identifier: AGPL-3.0-only
/**
 * (Re)download the fixture corpus from the URLs in urls.ts into ./fixtures.
 * See README.md. Run: `bun run extraction:fidelity:fetch`
 *
 * Not built on scripts/detectors/util.ts `fetchProbe` because that decodes via
 * `res.text()` (hard UTF-8 per the fetch spec) — fixtures need charset-aware
 * byte decoding so legacy ISO-8859-1 municipal pages don't get mojibake'd at
 * capture time. UA + timeout follow the same house conventions fetchProbe uses.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_URLS } from "./urls";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const UA = "kravla/extraction-fidelity (+https://github.com/eneo-ai/kravla)";
const TIMEOUT_MS = 12_000;

/**
 * Decode a response body honoring its declared charset: the Content-Type
 * charset parameter first, then an http-equiv/meta-charset sniff of the first
 * 1024 bytes, defaulting to UTF-8. `res.text()` would decode everything as
 * UTF-8 regardless of the header (verified in bun), turning å/ä/ö into U+FFFD
 * on legacy-encoded pages.
 */
function decodeBody(buf: ArrayBuffer, contentType: string | null): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 1024));
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
      /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

async function main() {
  mkdirSync(FIXTURES, { recursive: true });
  const entries = Object.entries(FIXTURE_URLS);
  console.log(`Fetching ${entries.length} fixtures...\n`);
  for (const [file, url] of entries) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // The mapping in urls.ts must hold the URL the HTML is actually served
      // from — candidates resolve relative links against it. A redirect means
      // the mapping is stale (this is how stockholm.se → start.stockholm
      // silently skewed the corpus once).
      if (res.url && res.url !== url) {
        console.warn(
          `  STALE ${file}: ${url}\n        now redirects to ${res.url} — update urls.ts, then re-run. Skipped.`,
        );
        continue;
      }
      const html = decodeBody(await res.arrayBuffer(), res.headers.get("content-type"));
      if (!res.ok || html.length < 1000) {
        console.warn(`  SKIP ${file}  (HTTP ${res.status}, ${html.length} chars) <- ${url}`);
        continue;
      }
      const fffd = (html.match(/�/g) ?? []).length;
      if (fffd > 0) {
        console.warn(
          `  WARN ${file}: ${fffd} U+FFFD replacement chars — charset decode likely wrong, inspect before trusting.`,
        );
      }
      writeFileSync(join(FIXTURES, file), html);
      console.log(`  ok   ${file}  (${html.length.toLocaleString("en")} chars)`);
    } catch (err) {
      console.warn(`  FAIL ${file}  <- ${url}: ${(err as Error).message}`);
    }
  }
  console.log("\nDone. Run `bun run extraction:fidelity` to compare.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
