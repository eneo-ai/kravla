// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The HTTP surface, framework-free on node:http so it runs identically
 * under Bun, Node, and vitest. `createApp` returns a plain request handler
 * plus its registry — tests mount it on an ephemeral port.
 *
 * Routes:
 *   GET    /healthz          — liveness, no auth
 *   POST   /v1/crawls        — run a crawl (NDJSON stream | webhook 202)
 *   GET    /v1/crawls/{id}   — webhook job status
 *   DELETE /v1/crawls/{id}   — cancel a webhook job
 *   POST   /v1/preview       — dry-run probe of a candidate source
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { previewCrawlSource, type Logger } from "kravla";
import type { ZodType } from "zod";
import type { ServiceConfig } from "./config";
import { runCrawlJob } from "./dispatch";
import { JobRegistry, type Job, type JobTargetState } from "./jobs";
import {
  CrawlRequestSchema,
  PreviewRequestSchema,
  type CrawlRequest,
  type WebhookDelivery,
  type WebhookTarget,
} from "./schema";
import { assertSafeWebhookUrl, deliverWebhook } from "./webhook";
import { previewToWire, type CrawlEvent, type DoneEvent } from "./wire";

const MAX_BODY_BYTES = 10 * 1024 * 1024; // conditional_gets for a big site can be sizable

type App = {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  registry: JobRegistry;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new HttpError(400, "request body is empty");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, "invalid request", result.error.issues);
  }
  return result.data;
}

function isAuthorized(req: IncomingMessage, apiKey: string | null): boolean {
  if (apiKey === null) return true; // auth explicitly disabled via env
  const header = req.headers.authorization;
  if (header === `Bearer ${apiKey}`) return true;
  return req.headers["x-api-key"] === apiKey;
}

export function createApp(config: ServiceConfig, logger: Logger): App {
  const registry = new JobRegistry();

  async function handleCrawl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = parseBody(CrawlRequestSchema, await readJsonBody(req));

    if (request.delivery.mode === "webhook") {
      for (const target of request.delivery.targets) {
        try {
          await assertSafeWebhookUrl(target.url, config.webhookAllowPrivate);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new HttpError(400, `delivery target ${target.name}: ${message}`);
        }
      }
    }

    if (!registry.tryAcquire(config.maxConcurrentCrawls)) {
      res.setHeader("retry-after", "30");
      throw new HttpError(
        429,
        `crawl capacity saturated (MAX_CONCURRENT_CRAWLS=${config.maxConcurrentCrawls})`,
      );
    }

    try {
      if (request.delivery.mode === "stream") {
        await streamCrawl(request, res);
      } else {
        webhookCrawl(request, request.delivery, res);
      }
    } finally {
      if (request.delivery.mode === "stream") registry.release();
      // webhook mode releases its slot when the detached job settles
    }
  }

  async function streamCrawl(request: CrawlRequest, res: ServerResponse): Promise<void> {
    const controller = new AbortController();
    // Client gone = cancel. Crawlee aborts its autoscaled pool and the
    // (already-counted) partial outcome is simply never written anywhere.
    res.on("close", () => controller.abort());

    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });

    const writeLine = (event: CrawlEvent | DoneEvent) => {
      if (!res.writableEnded && !controller.signal.aborted) {
        res.write(JSON.stringify(event) + "\n");
      }
    };

    const log = logger.child({ mode: "stream", url: request.url, crawlType: request.crawl_type });
    log.info({}, "crawl started");
    try {
      const { done } = await runCrawlJob({
        request,
        config,
        logger: log,
        signal: controller.signal,
        onEvent: writeLine,
      });
      writeLine(done);
      log.info({ status: done.status }, "crawl finished");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "crawl failed");
      writeLine({ type: "done", status: "failed", outcome: null, error: message });
    } finally {
      res.end();
    }
  }

  function webhookCrawl(
    request: CrawlRequest,
    delivery: WebhookDelivery,
    res: ServerResponse,
  ): void {
    const job = registry.create(delivery.targets.map((t) => ({ name: t.name, url: t.url })));
    const log = logger.child({
      mode: "webhook",
      jobId: job.id,
      url: request.url,
      crawlType: request.crawl_type,
    });

    // Detach: the crawl runs past this response's lifetime.
    void runWebhookJob(job, request, delivery, log).finally(() => registry.release());

    sendJson(res, 202, { job_id: job.id });
  }

  /** Per-target delivery runtime — buffers/sequences stay out of the registry. */
  type TargetRun = {
    target: WebhookTarget;
    state: JobTargetState;
    buffer: CrawlEvent[];
    sequence: number;
  };

  async function runWebhookJob(
    job: Job,
    request: CrawlRequest,
    delivery: WebhookDelivery,
    log: Logger,
  ): Promise<void> {
    const runs: TargetRun[] = delivery.targets.map((target, i) => ({
      target,
      state: job.targets[i]!,
      buffer: [],
      sequence: 0,
    }));
    let allTargetsFailed = false;

    // One signed POST to one target. A target that exhausts its retry budget
    // goes terminally `failed` and is excluded from every later flush — the
    // crawl and the surviving targets continue. Each receiver sees its own
    // gapless 1..n sequence (batch boundaries differ when batch_sizes do).
    const flushTarget = async (run: TargetRun, done?: DoneEvent): Promise<void> => {
      if (run.state.status === "failed") return;
      if (run.buffer.length === 0 && !done) return;
      run.sequence += 1;
      const body = JSON.stringify({
        job_id: job.id,
        sequence: run.sequence,
        events: run.buffer,
        ...(done ? { done } : {}),
      });
      run.buffer = [];
      try {
        await deliverWebhook({
          url: run.target.url,
          secret: run.target.secret,
          jobId: job.id,
          sequence: run.sequence,
          body,
          logger: log,
        });
        run.state.deliveredBatches = run.sequence;
        if (done) run.state.status = "delivered";
      } catch (err) {
        run.state.status = "failed";
        run.state.error = err instanceof Error ? err.message : String(err);
        log.warn(
          { target: run.state.name, err: run.state.error },
          "delivery target failed; excluded from remaining flushes",
        );
        if (runs.every((r) => r.state.status === "failed")) {
          // Nobody is listening — stop hitting the crawled site.
          allTargetsFailed = true;
          job.controller.abort();
        }
      }
    };

    log.info({ targets: runs.map((r) => r.state.name) }, "crawl started");
    try {
      const { done } = await runCrawlJob({
        request,
        config,
        logger: log,
        signal: job.controller.signal,
        onEvent: async (event) => {
          const due: Promise<void>[] = [];
          for (const run of runs) {
            if (run.state.status === "failed") continue;
            run.buffer.push(event);
            if (run.buffer.length >= run.target.batch_size) due.push(flushTarget(run));
          }
          // Awaited by the crawler — the slowest active receiver backpressures
          // the crawl. In-flight memory is bounded by the sum of batch_sizes.
          if (due.length > 0) await Promise.all(due);
        },
      });
      await Promise.all(runs.map((run) => flushTarget(run, done)));

      const deliveredCount = runs.filter((r) => r.state.status === "delivered").length;
      if (allTargetsFailed || deliveredCount === 0) {
        registry.finish(job, "failed", done, "all delivery targets failed");
      } else if (done.status === "cancelled") {
        registry.finish(job, "cancelled", done);
      } else if (deliveredCount === runs.length) {
        registry.finish(job, "completed", done);
      } else {
        registry.finish(
          job,
          "partial",
          done,
          `${runs.length - deliveredCount} of ${runs.length} delivery targets failed`,
        );
      }
      log.info({ status: job.status }, "crawl finished");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      registry.finish(job, "failed", null, message);
      log.error({ err: message }, "crawl failed");
      // Best-effort failure notice to the targets still listening; status
      // stays queryable via GET /v1/crawls/{id} either way.
      const failureDone: DoneEvent = {
        type: "done",
        status: "failed",
        outcome: null,
        error: message,
      };
      await Promise.all(runs.map((run) => flushTarget(run, failureDone).catch(() => {})));
    }
  }

  function jobStatusBody(job: Job) {
    const nonFailed = job.targets.filter((t) => t.status !== "failed");
    return {
      job_id: job.id,
      status: job.status,
      created_at: job.createdAt.toISOString(),
      finished_at: job.finishedAt?.toISOString() ?? null,
      // Back-compat aggregate: batches every still-healthy receiver has.
      delivered_batches: nonFailed.length
        ? Math.min(...nonFailed.map((t) => t.deliveredBatches))
        : 0,
      targets: job.targets.map((t) => ({
        name: t.name,
        url: t.url,
        status: t.status,
        delivered_batches: t.deliveredBatches,
        error: t.error,
      })),
      outcome: job.done?.outcome ?? null,
      error: job.error,
    };
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://internal");
    const route = `${req.method} ${url.pathname}`;

    void (async () => {
      try {
        if (route === "GET /healthz") {
          return sendJson(res, 200, { status: "ok", active_crawls: registry.active });
        }
        if (!isAuthorized(req, config.apiKey)) {
          return sendJson(res, 401, { error: "missing or invalid API key" });
        }

        if (route === "POST /v1/crawls") return await handleCrawl(req, res);
        if (route === "POST /v1/preview") {
          const request = parseBody(PreviewRequestSchema, await readJsonBody(req));
          const result = await previewCrawlSource(
            {
              url: request.url,
              crawlType: request.crawl_type,
              depth: request.depth,
              crawlScope: request.scope,
              httpAuth: request.http_auth ?? null,
              excludeUrlPatterns: request.exclude_url_patterns,
              maxSampleFetches: request.max_sample_fetches,
            },
            { logger, userAgent: request.user_agent ?? config.userAgent },
          );
          return sendJson(res, 200, previewToWire(result));
        }

        const jobMatch = url.pathname.match(/^\/v1\/crawls\/([0-9a-f-]{36})$/);
        if (jobMatch?.[1] && (req.method === "GET" || req.method === "DELETE")) {
          const job = registry.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { error: "unknown job id" });
          if (req.method === "DELETE" && job.status === "running") {
            job.controller.abort();
            return sendJson(res, 202, jobStatusBody(job));
          }
          return sendJson(res, 200, jobStatusBody(job));
        }

        return sendJson(res, 404, { error: `no route: ${route}` });
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          return sendJson(res, err.status, { error: err.message, detail: err.detail });
        }
        logger.error(
          { err: err instanceof Error ? err.message : String(err), route },
          "unhandled error",
        );
        return sendJson(res, 500, { error: "internal error" });
      }
    })();
  };

  return { handler, registry };
}
