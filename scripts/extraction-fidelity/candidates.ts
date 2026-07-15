// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extraction candidates for the fidelity harness. See README.md for what each
 * candidate is and how to read the comparison.
 *
 * Non-production candidates reuse the production extractor's exported
 * internals (`parseHtmlDocument` from src/lib/crawler/extract.ts) so the
 * comparison can never drift from what production actually does — only the
 * extractor under test varies.
 */
import { Defuddle } from "defuddle/node";
import { extractContent, parseHtmlDocument } from "../../packages/core/src/extract";

export type ExtractionResult = {
  title: string | null;
  markdown: string;
  /** Short tag describing which internal path produced the output. */
  note: string;
};

export type Candidate = {
  id: string;
  label: string;
  run: (html: string, url: string) => ExtractionResult | Promise<ExtractionResult>;
};

export const candidates: Candidate[] = [
  {
    id: "current",
    label: "Current (Readability + linkedom + Turndown)",
    run: (html, url) => {
      const r = extractContent(html, url);
      return {
        title: r.title,
        markdown: r.markdown,
        note: r.readabilityUsed ? "readability" : "cheerio-fallback",
      };
    },
  },
  {
    id: "defuddle-linkedom",
    label: "Defuddle + linkedom (Markdown output)",
    run: async (html, url) => {
      const r = await Defuddle(parseHtmlDocument(html, url), url, { markdown: true });
      return {
        title: r.title?.trim() || null,
        markdown: (r.content ?? "").trim(),
        note: `defuddle (${r.wordCount ?? 0} words)`,
      };
    },
  },
];
