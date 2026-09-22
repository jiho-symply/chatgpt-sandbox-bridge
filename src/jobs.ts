import { randomUUID } from "node:crypto";
import type { CodexExecutor, ExecResult } from "./codex-executor.js";

export type JobStatus = "running" | "completed" | "failed";

export interface JobView {
  job_id: string;
  request_id: string;
  status: JobStatus;
  command: string[];
  cwd: string;
  created_at: string;
  finished_at?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface Job extends JobView {
  done: Promise<void>;
  resolveDone: () => void;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly requestIds = new Map<string, string>();

  constructor(
    private readonly executor: CodexExecutor,
    private readonly maxJobs: number
  ) {}

  start(input: {
    requestId: string;
    command: string[];
    cwd: string;
    timeoutMs: number;
  }): JobView {
    const existingId = this.requestIds.get(input.requestId);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (!existing) throw new Error("request_id index is inconsistent");
      if (
        existing.cwd !== input.cwd ||
        JSON.stringify(existing.command) !== JSON.stringify(input.command)
      ) {
        throw new Error("request_id was already used with different content");
      }
      return this.view(existing);
    }

    if (this.jobs.size >= this.maxJobs) {
      const removable = [...this.jobs.values()]
        .filter(job => job.status !== "running")
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      if (!removable) throw new Error("too many running jobs");
      this.jobs.delete(removable.job_id);
      this.requestIds.delete(removable.request_id);
    }

    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const job: Job = {
      job_id: randomUUID(),
      request_id: input.requestId,
      status: "running",
      command: [...input.command],
      cwd: input.cwd,
      created_at: new Date().toISOString(),
      done,
      resolveDone
    };
    this.jobs.set(job.job_id, job);
    this.requestIds.set(job.request_id, job.job_id);

    void this.executor.exec({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs
    }).then(
      (result: ExecResult) => {
        job.status = "completed";
        job.exit_code = result.exitCode;
        job.stdout = result.stdout;
        job.stderr = result.stderr;
      },
      (error: unknown) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
    ).finally(() => {
      job.finished_at = new Date().toISOString();
      job.resolveDone();
    });

    return this.view(job);
  }

  async get(jobId: string, waitMs = 0): Promise<JobView> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("unknown job_id");
    if (job.status === "running" && waitMs > 0) {
      await Promise.race([
        job.done,
        new Promise<void>(resolve => setTimeout(resolve, waitMs))
      ]);
    }
    return this.view(job);
  }

  recent(limit = 20): JobView[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(job => this.view(job));
  }

  private view(job: Job): JobView {
    const {
      done: _done,
      resolveDone: _resolveDone,
      ...view
    } = job;
    return { ...view };
  }
}
