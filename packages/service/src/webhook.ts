// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Webhook delivery: SSRF guard + HMAC-signed batch POSTs.
 *
 * Every callback body is signed with HMAC-SHA256 over the exact bytes sent:
 * `X-Kravla-Signature: sha256=<hex>`. Receivers must recompute over the raw
 * body before parsing.
 */
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Logger } from "kravla";

const DELIVERY_ATTEMPTS = 3;
const DELIVERY_BACKOFF_MS = [1_000, 5_000];
const DELIVERY_TIMEOUT_MS = 30_000;

/** RFC1918/loopback/link-local/ULA — refused as webhook targets by default. */
function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateIp(mapped[1]);
    if (v6 === "::1" || v6 === "::") return true;
    return (
      v6.startsWith("fc") ||
      v6.startsWith("fd") ||
      v6.startsWith("fe8") ||
      v6.startsWith("fe9") ||
      v6.startsWith("fea") ||
      v6.startsWith("feb")
    );
  }
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true; // unparseable → refuse
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Validate a webhook URL before accepting the job: http(s) only, and the
 * hostname must not resolve to a private/loopback address (unless the
 * operator opted in via KRAVLA_WEBHOOK_ALLOW_PRIVATE for dev/test).
 * Throws with a caller-facing message when refused.
 */
export async function assertSafeWebhookUrl(rawUrl: string, allowPrivate: boolean): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`webhook URL must be http(s), got ${url.protocol}`);
  }
  if (allowPrivate) return;
  const host = url.hostname;
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (ips.length === 0) throw new Error(`webhook host ${host} did not resolve`);
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new Error(`webhook host ${host} resolves to a private address (${ip})`);
    }
  }
}

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * POST one signed payload, retrying transient failures. Throws after the
 * retry budget — the caller marks the job failed (we never silently drop
 * pages a consumer is counting on).
 */
export async function deliverWebhook(args: {
  url: string;
  secret: string;
  jobId: string;
  sequence: number;
  body: string;
  logger: Logger;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(args.url, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          "x-kravla-signature": signBody(args.secret, args.body),
          "x-kravla-job-id": args.jobId,
          "x-kravla-sequence": String(args.sequence),
        },
        body: args.body,
      });
      // Drain so the socket can be reused; the body content is irrelevant.
      await res.arrayBuffer().catch(() => {});
      if (res.ok) return;
      lastError = new Error(`webhook returned HTTP ${res.status}`);
      // 4xx (other than 408/429) is deterministic — retrying won't help.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < DELIVERY_ATTEMPTS - 1) {
      args.logger.warn(
        {
          jobId: args.jobId,
          sequence: args.sequence,
          attempt: attempt + 1,
          err: String(lastError),
        },
        "webhook delivery failed; retrying",
      );
      await new Promise((r) => setTimeout(r, DELIVERY_BACKOFF_MS[attempt] ?? 5_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
