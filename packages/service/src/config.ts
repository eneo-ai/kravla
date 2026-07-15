// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Environment configuration. Single-tenant headless infra: one static API
 * key, one process, no persistence. Every per-crawl knob can also be set
 * per request; these env values are the process-wide defaults.
 */
export type ServiceConfig = {
  port: number;
  /** Optional extra listener that serves only /healthz (no auth). */
  healthPort: number | null;
  /** Static bearer key. `null` only when auth is explicitly disabled. */
  apiKey: string | null;
  /** Active crawl jobs (stream + webhook) beyond which new submissions get 429. */
  maxConcurrentCrawls: number;
  /** Allow webhook callbacks to private/loopback addresses (dev/test only). */
  webhookAllowPrivate: boolean;
  userAgent: string | undefined;
  pageConcurrency: number | undefined;
  memoryMbytes: number | undefined;
  requestHandlerTimeoutSecs: number | undefined;
  maxHtmlBytes: number | undefined;
};

function intOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`expected a non-negative integer, got "${raw}"`);
  return n;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const apiKey = env.CRAWLER_API_KEY?.trim() || null;
  if (!apiKey && env.KRAVLA_AUTH_DISABLED !== "true") {
    throw new Error(
      "CRAWLER_API_KEY is not set. Set it, or set KRAVLA_AUTH_DISABLED=true to run without auth (not recommended outside local dev).",
    );
  }
  return {
    port: intOrUndefined(env.PORT) ?? 8080,
    healthPort: intOrUndefined(env.HEALTH_PORT) ?? null,
    apiKey,
    maxConcurrentCrawls: intOrUndefined(env.MAX_CONCURRENT_CRAWLS) ?? 2,
    webhookAllowPrivate: env.KRAVLA_WEBHOOK_ALLOW_PRIVATE === "true",
    userAgent: env.KRAVLA_USER_AGENT || undefined,
    pageConcurrency: intOrUndefined(env.KRAVLA_PAGE_CONCURRENCY),
    memoryMbytes: intOrUndefined(env.KRAVLA_MEMORY_MBYTES),
    requestHandlerTimeoutSecs: intOrUndefined(env.KRAVLA_REQUEST_HANDLER_TIMEOUT_SECS),
    maxHtmlBytes: intOrUndefined(env.KRAVLA_MAX_HTML_BYTES),
  };
}
