// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Schema.org JSON-LD walker. Pulls structured fields out of every
 * `<script type="application/ld+json">` block on the page — the recon
 * showed Sitevision-hybrid + WordPress munis emit rich graphs
 * (NewsArticle, BreadcrumbList, GovernmentOrganization, ContactPoint,
 * Person, Event, FAQPage). Pages without JSON-LD produce no output.
 *
 * Strategy:
 *   1. Parse each block defensively — malformed JSON-LD is common on
 *      municipal sites (extra trailing commas, missing quotes). One bad
 *      block doesn't sink the others.
 *   2. Walk the tree. JSON-LD nests heavily through `@graph` arrays and
 *      inline references; we recurse and collect any node carrying an
 *      `@type` we recognise. Other types are silently skipped.
 *   3. Map per-type:
 *        Article/NewsArticle → `jsonLd.article` (headline, dates, section).
 *        BreadcrumbList      → `jsonLd.breadcrumbs[]` (names in order).
 *        Person              → contact extraChunk + `jsonLd.contacts[]`.
 *        ContactPoint        → contact extraChunk + appended to org block.
 *        GovernmentOrganization/Organization → `jsonLd.organization`.
 *        Event               → `jsonLd.events[]`.
 *        FAQPage             → one extraChunk per Q/A pair.
 *
 * Multiple instances of the same type accumulate (e.g. several Persons
 * on a contacts page). The metadata is namespaced under `jsonLd` so it
 * never collides with the head-meta enricher's `article` namespace, even
 * when both have publish dates.
 */
import type { Enricher, Enrichment } from "./types";

type Bag = Record<string, unknown>;

const enricher: Enricher = {
  id: "json-ld",
  enrich({ $ }) {
    const blocks: unknown[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).text();
      if (!raw.trim()) return;
      try {
        const parsed = JSON.parse(raw);
        blocks.push(parsed);
      } catch {
        // Malformed JSON-LD is common; one bad block shouldn't sink the others.
      }
    });
    if (blocks.length === 0) return null;

    const breadcrumbs: string[] = [];
    const events: Bag[] = [];
    const articleBag: Bag = {};
    const organization: Bag = {};
    const contactsForOrg: Bag[] = [];
    const personChunks: string[] = [];
    const faqChunks: string[] = [];
    const personMetadata: Bag[] = [];

    // Track visited objects so the recursion doesn't process the same
    // node twice. Without this, a typed node reached both via an explicit
    // mainEntity / @graph loop AND via the generic "walk all properties"
    // recursion would emit duplicates — observed in CI as duplicate
    // FAQPage Q/A chunks and double-counted ContactPoint entries.
    const visited = new WeakSet<object>();
    const visit = (node: unknown) => {
      if (!node) return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (typeof node !== "object") return;
      const obj = node as Bag;
      if (visited.has(obj)) return;
      visited.add(obj);

      const typeField = obj["@type"];
      const types = typesOf(typeField);
      if (types.length === 0) {
        // Container node (@graph wrapper, untyped intermediate) — recurse
        // into its properties so we find typed children.
        for (const v of Object.values(obj)) visit(v);
        return;
      }

      for (const t of types) {
        switch (t) {
          case "Article":
          case "NewsArticle":
          case "BlogPosting": {
            const headline = stringOf(obj["headline"]);
            if (headline && !articleBag.headline) articleBag.headline = headline;
            const datePublished = stringOf(obj["datePublished"]);
            if (datePublished && !articleBag.publishedAt) articleBag.publishedAt = datePublished;
            const dateModified = stringOf(obj["dateModified"]);
            if (dateModified && !articleBag.modifiedAt) articleBag.modifiedAt = dateModified;
            const section = stringOf(obj["articleSection"]);
            if (section && !articleBag.section) articleBag.section = section;
            const author = stringOf(obj["author"]) ?? stringOf((obj["author"] as Bag)?.["name"]);
            if (author && !articleBag.author) articleBag.author = author;
            break;
          }
          case "BreadcrumbList": {
            const items = arrayOf(obj["itemListElement"]);
            // ListItem entries are usually objects with `name` + `position`;
            // sort by position so out-of-order JSON still renders correctly.
            const ordered = items
              .map((item) => {
                const i = item as Bag;
                const pos = Number(i["position"]);
                const name = stringOf(i["name"]) ?? stringOf((i["item"] as Bag)?.["name"]);
                return { pos: Number.isFinite(pos) ? pos : 0, name };
              })
              .filter((x): x is { pos: number; name: string } => x.name != null)
              .sort((a, b) => a.pos - b.pos);
            for (const { name } of ordered) if (!breadcrumbs.includes(name)) breadcrumbs.push(name);
            break;
          }
          case "Person": {
            const name = stringOf(obj["name"]);
            const jobTitle = stringOf(obj["jobTitle"]);
            const telephone = stringOf(obj["telephone"]);
            const email = stringOf(obj["email"]);
            if (name || telephone || email) {
              const chunk = formatContactLine({ name, role: jobTitle, telephone, email });
              if (chunk) personChunks.push(chunk);
              personMetadata.push({ name, jobTitle, telephone, email });
            }
            break;
          }
          case "ContactPoint": {
            const telephone = stringOf(obj["telephone"]);
            const email = stringOf(obj["email"]);
            const contactType = stringOf(obj["contactType"]);
            if (telephone || email) {
              contactsForOrg.push({ contactType, telephone, email });
              const chunk = formatContactLine({ name: contactType, telephone, email });
              if (chunk) personChunks.push(chunk);
            }
            break;
          }
          case "GovernmentOrganization":
          case "Organization":
          case "Corporation": {
            const name = stringOf(obj["name"]);
            const url = stringOf(obj["url"]);
            if (name && !organization.name) organization.name = name;
            if (url && !organization.url) organization.url = url;
            const sameAs = arrayOf(obj["sameAs"])
              .map((v) => stringOf(v))
              .filter((v): v is string => v != null);
            if (sameAs.length > 0 && !organization.sameAs) organization.sameAs = sameAs;
            break;
          }
          case "Event": {
            const name = stringOf(obj["name"]);
            if (!name) break;
            const startDate = stringOf(obj["startDate"]);
            const endDate = stringOf(obj["endDate"]);
            const locationName =
              stringOf(obj["location"]) ?? stringOf((obj["location"] as Bag)?.["name"]);
            events.push({ name, startDate, endDate, location: locationName });
            break;
          }
          case "Question": {
            // Each Question emits one Q/A chunk — works whether it's a
            // standalone node or nested inside a FAQPage's mainEntity.
            // We DON'T have a separate FAQPage handler that loops over
            // mainEntity itself; the recursion below walks into mainEntity
            // and lands here for each Question, and `visited` ensures
            // each Question is processed once.
            const q = stringOf(obj["name"]);
            const a =
              stringOf((obj["acceptedAnswer"] as Bag)?.["text"]) ??
              stringOf((obj["suggestedAnswer"] as Bag)?.["text"]);
            if (q && a) faqChunks.push(`Q: ${q}\nA: ${stripTags(a)}`);
            break;
          }
          case "FAQPage":
            // FAQPage itself carries no field-level data beyond `mainEntity`;
            // Questions inside are handled when the recursion visits them.
            break;
        }
      }

      // Continue walking — typed nodes often have nested typed nodes
      // (Organization → ContactPoint → PostalAddress, etc.).
      for (const v of Object.values(obj)) visit(v);
    };

    for (const block of blocks) visit(block);

    if (contactsForOrg.length > 0) organization.contactPoints = contactsForOrg;

    const metadata: Bag = {};
    const jsonLd: Bag = {};
    if (breadcrumbs.length > 0) jsonLd.breadcrumbs = breadcrumbs;
    if (events.length > 0) jsonLd.events = events;
    if (Object.keys(articleBag).length > 0) jsonLd.article = articleBag;
    if (Object.keys(organization).length > 0) jsonLd.organization = organization;
    if (personMetadata.length > 0) jsonLd.persons = personMetadata;

    if (Object.keys(jsonLd).length === 0 && personChunks.length === 0 && faqChunks.length === 0) {
      return null;
    }
    if (Object.keys(jsonLd).length > 0) metadata.jsonLd = jsonLd;

    const extraChunks = [...personChunks, ...faqChunks];
    const enrichment: Enrichment = { metadata, extraChunks };
    return enrichment;
  },
};

function typesOf(field: unknown): string[] {
  if (typeof field === "string") return [field];
  if (Array.isArray(field)) return field.filter((v): v is string => typeof v === "string");
  return [];
}

function stringOf(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

function arrayOf(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

/**
 * Build a single line of contact text from whichever fields are populated.
 * Returns null when nothing useful is present — caller filters.
 */
function formatContactLine(input: {
  name?: string;
  role?: string;
  telephone?: string;
  email?: string;
}): string | null {
  const parts: string[] = [];
  if (input.name) parts.push(input.name);
  if (input.role) parts.push(input.role);
  if (input.telephone) parts.push(`tel ${input.telephone}`);
  if (input.email) parts.push(`email ${input.email}`);
  return parts.length > 0 ? `Contact: ${parts.join(", ")}` : null;
}

/** FAQ answers in JSON-LD frequently include inline HTML (`<p>…</p>`). */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default enricher;
