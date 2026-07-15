// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Wire schemas for the v1 API. snake_case on the wire (Python-friendly),
 * camelCase internally.
 */
import { z } from "zod";

const HttpAuthSchema = z.object({
  user: z.string().min(1),
  password: z.string(),
});

const LimitsSchema = z.object({
  /** Maps to Crawlee's maxRequestsPerCrawl. */
  max_pages: z.number().int().min(1).optional(),
  /** Wall-clock cap for the whole job; the crawl is aborted when it fires. */
  max_seconds: z.number().int().min(1).optional(),
  max_requests_per_minute: z.number().int().min(1).optional(),
  /** Minimum gap between two requests to the same host. */
  request_delay_seconds: z.number().min(0).optional(),
});

const ConditionalGetSchema = z.object({
  url: z.url(),
  etag: z.string().nullish(),
  last_modified: z.string().nullish(),
});

const WebhookTargetSchema = z.object({
  url: z.url(),
  /** HMAC-SHA256 key for the X-Kravla-Signature header on every callback. */
  secret: z.string().min(16, "webhook secret must be at least 16 characters"),
  batch_size: z.number().int().min(1).max(500).default(25),
  /** Label echoed in job status; defaults to `target-<index>`. */
  name: z.string().min(1).max(64).optional(),
});

export const MAX_WEBHOOK_TARGETS = 5;

// The webhook branch accepts either `targets` (fan-out, 1-5 receivers) or the
// legacy flat single-target fields from the alpha API — never both. The
// normalization to `{mode, targets}` happens in the top-level transform below
// (zod discriminated unions don't admit transformed members).
const DeliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("stream") }),
  z.object({
    mode: z.literal("webhook"),
    targets: z.array(WebhookTargetSchema).min(1).max(MAX_WEBHOOK_TARGETS).optional(),
    /** @deprecated legacy single-target shape — use `targets`. */
    url: z.url().optional(),
    secret: z.string().min(16, "webhook secret must be at least 16 characters").optional(),
    batch_size: z.number().int().min(1).max(500).optional(),
  }),
]);

/** A webhook target after normalization — `name` is always set. */
export type WebhookTarget = Omit<z.infer<typeof WebhookTargetSchema>, "name"> & { name: string };
export type Delivery = { mode: "stream" } | { mode: "webhook"; targets: WebhookTarget[] };

const RawCrawlRequestSchema = z.object({
  url: z.url(),
  crawl_type: z.enum(["crawl", "sitemap", "feed", "open_eplatform"]).default("crawl"),
  depth: z.number().int().min(0).max(10).default(1),
  scope: z.enum(["depth_limited", "path_prefix"]).optional(),
  http_auth: HttpAuthSchema.nullish(),
  exclude_url_patterns: z.array(z.string()).max(200).optional(),
  index_linked_files: z.boolean().optional(),
  limits: LimitsSchema.optional(),
  conditional_gets: z.array(ConditionalGetSchema).max(50_000).optional(),
  /** URLs already processed in a prior attempt — counted as skipped, not re-delivered. */
  skip_urls: z.array(z.string()).max(100_000).optional(),
  /**
   * Pre-resolved sitemap URLs (sitemap mode only). When set, the service
   * skips its own sitemap discovery/load — callers that already filtered by
   * lastmod keep that filtering.
   */
  sitemap_urls: z.array(z.url()).max(100_000).optional(),
  /** Display name stamped on open_eplatform page metadata (callers own the registry). */
  municipality_name: z.string().min(1).max(200).optional(),
  /** Override the robots/User-Agent product token for this job. */
  user_agent: z.string().min(1).max(200).optional(),
  delivery: DeliverySchema.default({ mode: "stream" }),
});

export type CrawlRequest = Omit<z.infer<typeof RawCrawlRequestSchema>, "delivery"> & {
  delivery: Delivery;
};
export type WebhookDelivery = Extract<Delivery, { mode: "webhook" }>;

export const CrawlRequestSchema = RawCrawlRequestSchema.superRefine((req, ctx) => {
  if (req.sitemap_urls && req.crawl_type !== "sitemap") {
    ctx.addIssue({
      code: "custom",
      path: ["sitemap_urls"],
      message: 'sitemap_urls requires crawl_type "sitemap"',
    });
  }
  if (req.municipality_name && req.crawl_type !== "open_eplatform") {
    ctx.addIssue({
      code: "custom",
      path: ["municipality_name"],
      message: 'municipality_name requires crawl_type "open_eplatform"',
    });
  }
  if (req.delivery.mode !== "webhook") return;
  const d = req.delivery;
  if (d.targets && (d.url !== undefined || d.secret !== undefined || d.batch_size !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "specify either delivery.targets or the legacy url/secret fields, not both",
    });
  } else if (!d.targets && !(d.url && d.secret)) {
    ctx.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "webhook delivery requires targets (or the legacy url + secret fields)",
    });
  }
}).transform((req): CrawlRequest => {
  if (req.delivery.mode !== "webhook") return { ...req, delivery: { mode: "stream" } };
  const d = req.delivery;
  const raw = d.targets ?? [{ url: d.url!, secret: d.secret!, batch_size: d.batch_size ?? 25 }];
  const targets = raw.map((t, i) => ({ ...t, name: t.name ?? `target-${i}` }));
  return { ...req, delivery: { mode: "webhook", targets } };
});

export const PreviewRequestSchema = z.object({
  url: z.url(),
  crawl_type: z.enum(["crawl", "sitemap"]).default("crawl"),
  depth: z.number().int().min(0).max(10).default(1),
  scope: z.enum(["depth_limited", "path_prefix"]).optional(),
  http_auth: HttpAuthSchema.nullish(),
  exclude_url_patterns: z.array(z.string()).max(200).optional(),
  max_sample_fetches: z.number().int().min(1).max(200).optional(),
  user_agent: z.string().min(1).max(200).optional(),
});

export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;
