// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Structured per-e-service metadata produced by the Open ePlatform crawler.
 *
 * Stored as `source_document.metadata` (jsonb) alongside `rawText`. The `provider`
 * discriminator lets the `search_eservices` tool refuse mixed-provider
 * collections — a Collection that mixes Open ePlatform pages with generic
 * web crawls would return half-empty records, so we error early instead.
 *
 * Field provenance — these mirror Open ePlatform's HTML attributes
 * (`data-flowtypeid`, `data-flowid`, `.icon-person`, `.icon-launch`, …) so
 * the parser is the only place they need to be mapped from HTML.
 */
import { z } from "zod";

export const OPEN_EPLATFORM_PROVIDER = "open_eplatform" as const;

/**
 * Per-overview-page metadata, harvested by visiting the service's overview
 * URL (`/oversikt/overview/{id}`). All inner fields are nullable / empty
 * arrays because the Nordic Peak template ships several sections as
 * optional: smaller portals (e.g. Hudiksvall) omit the GDPR `simplebox-owner`
 * panel entirely, and some services have no sidebar requirements list.
 *
 * Whole block is nullable when overview enrichment is disabled or the
 * overview fetch failed — the catalog row's other fields stay usable.
 */
export const OpenEplatformOverviewSchema = z.object({
  /** "Starta e-tjänsten" button — `/oversikt/flow/{id}`, relative on-portal. */
  flowStartUrl: z.string().nullable(),
  /** Numeric id parsed from `flowStartUrl`. Distinct from the catalog's flowId. */
  flowStartId: z.number().int().nullable(),
  /** `<meta name="description">` — short, sometimes generic. */
  metaDescription: z.string().nullable(),
  /** Long-form description from `.description.textcontent`. */
  descriptionText: z.string().nullable(),
  /** Sidebar "Följande behövs" checklist; empty when the service has no preconditions. */
  requirements: z.array(z.string()),
  /** Ordered service-navigator steps; `data-step="N"` carries the index. */
  steps: z.array(z.string()),
  /** Outbound links from the description body (mailto/tel filtered out). */
  relatedLinks: z.array(z.object({ href: z.string(), text: z.string() })),
  /**
   * Contact box — either the `#simplebox-contact` collapsible (Sundsvall
   * pattern) or the inline `.about-flow` block (Hudiksvall pattern). Null
   * when neither selector matches.
   */
  contact: z
    .object({
      department: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
    })
    .nullable(),
  /**
   * Data-controller / GDPR panel (`#simplebox-owner`). Stored as a flat
   * sequence of `<h3>` headings → list/paragraph items so we don't
   * string-match Swedish labels like "Lagringstid" or
   * "Personuppgiftsansvarig". `email` is extracted via the mailto link
   * — the data-controller email is the only mailto inside the panel.
   */
  dataController: z
    .object({
      sections: z.array(z.object({ heading: z.string(), items: z.array(z.string()) })),
      email: z.string().nullable(),
    })
    .nullable(),
});

export type OpenEplatformOverview = z.infer<typeof OpenEplatformOverviewSchema>;

export const OpenEplatformPageMetadataSchema = z.object({
  provider: z.literal(OPEN_EPLATFORM_PROVIDER),
  serviceName: z.string().min(1),
  description: z.string(),
  category: z.string().nullable(),
  requiresLogin: z.boolean(),
  isExternal: z.boolean(),
  /** Direct deep-link to start the service (login-gated or public). */
  serviceUrl: z.string().url().nullable(),
  /** Portal root (the URL the operator entered). Useful for the LLM to cite. */
  portalUrl: z.string().url(),
  /** Display name of the municipality. Copied from the source's parameterValues. */
  municipalityName: z.string().nullable(),
  /** Open ePlatform's internal flow id, kept for diagnostics/dedup. */
  upstreamFlowId: z.string().nullable(),
  /** Open ePlatform's internal overview id (from `/overview/{id}` URLs). */
  upstreamOverviewId: z.string().nullable(),
  /** Structured fields harvested from the service's overview page. */
  overview: OpenEplatformOverviewSchema.nullable(),
});

export type OpenEplatformPageMetadata = z.infer<typeof OpenEplatformPageMetadataSchema>;

export function isOpenEplatformMetadata(
  m: Record<string, unknown> | null | undefined,
): m is OpenEplatformPageMetadata {
  return !!m && m.provider === OPEN_EPLATFORM_PROVIDER;
}
