// SPDX-License-Identifier: AGPL-3.0-only
/**
 * In-memory job registry. Deliberately no persistence or queue: a restart
 * forgets jobs and callers re-submit (stateful retries/schedules belong to
 * consumers and their own queues). Stream-mode jobs count
 * toward the concurrency cap but are never registered by id (cancel =
 * drop the connection); webhook jobs get an id for status/cancel.
 */
import { randomUUID } from "node:crypto";
import type { DoneEvent } from "./wire";

/** `partial` = the crawl completed but only a subset of delivery targets got it. */
export type JobStatus = "running" | "completed" | "partial" | "cancelled" | "failed";

/** Reportable per-receiver delivery state (buffers/sequences live in app.ts). */
export type JobTargetState = {
  name: string;
  url: string;
  status: "delivering" | "delivered" | "failed";
  deliveredBatches: number;
  error: string | null;
};

export type Job = {
  id: string;
  status: JobStatus;
  controller: AbortController;
  createdAt: Date;
  finishedAt: Date | null;
  /** Terminal event of the crawl, once finished. */
  done: DoneEvent | null;
  /** Failure detail when status === "failed" (crawl threw or delivery exhausted retries). */
  error: string | null;
  targets: JobTargetState[];
};

const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private activeCount = 0;

  /** Reserve a concurrency slot. Returns false when saturated (caller sends 429). */
  tryAcquire(max: number): boolean {
    if (this.activeCount >= max) return false;
    this.activeCount += 1;
    return true;
  }

  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  get active(): number {
    return this.activeCount;
  }

  create(targets: { name: string; url: string }[]): Job {
    const job: Job = {
      id: randomUUID(),
      status: "running",
      controller: new AbortController(),
      createdAt: new Date(),
      finishedAt: null,
      done: null,
      error: null,
      targets: targets.map((t) => ({
        name: t.name,
        url: t.url,
        status: "delivering",
        deliveredBatches: 0,
        error: null,
      })),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    this.prune();
    return this.jobs.get(id);
  }

  finish(
    job: Job,
    status: Exclude<JobStatus, "running">,
    done: DoneEvent | null,
    error?: string,
  ): void {
    job.status = status;
    job.done = done;
    job.error = error ?? null;
    job.finishedAt = new Date();
  }

  /** Drop finished jobs older than the TTL — bounds memory on long uptimes. */
  private prune(): void {
    const cutoff = Date.now() - FINISHED_JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && job.finishedAt.getTime() < cutoff) this.jobs.delete(id);
    }
  }
}
