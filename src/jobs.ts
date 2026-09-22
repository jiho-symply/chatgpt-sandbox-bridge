import { randomUUID } from "node:crypto";
import type { CodexRuntime, ExecResult } from "./codex-runtime.js";
import {
  JobStore,
  type JobRecord,
  type JobView
} from "./job-store.js";

export class JobManager {
  constructor(
    private readonly runtime: CodexRuntime,
    private readonly store: JobStore,
    private readonly longJobsEnabled: boolean,
    private readonly maxJobTimeoutMs: number
  ) {}

  run(input: {
    command: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<ExecResult> {
    return this.runtime.runCommand(input);
  }

  async start(input: {
    requestId: string;
    command: string[];
    cwd: string;
    absoluteCwd: string;
    timeoutMs: number | null;
  }): Promise<JobView> {
    if (!this.longJobsEnabled) {
      throw new Error(
        "long-running jobs are disabled; use an isolated container and set CSB_LONG_JOBS=1"
      );
    }

    if (input.timeoutMs !== null && input.timeoutMs > this.maxJobTimeoutMs) {
      throw new Error("timeout_ms exceeds CSB_MAX_JOB_TIMEOUT_MS");
    }

    const existing = this.store.findByRequestId(input.requestId);
    if (existing) {
      if (
        existing.cwd !== input.cwd ||
        existing.timeout_ms !== input.timeoutMs ||
        JSON.stringify(existing.command) !== JSON.stringify(input.command)
      ) {
        throw new Error("request_id was already used with different content");
      }
      return this.store.view(existing);
    }

    const now = new Date().toISOString();
    const jobId = randomUUID();
    const record: JobRecord = {
      job_id: jobId,
      request_id: input.requestId,
      process_handle: `csb-${jobId}`,
      status: "starting",
      command: [...input.command],
      cwd: input.cwd,
      timeout_ms: input.timeoutMs,
      created_at: now,
      updated_at: now,
      stdout_bytes: 0,
      stderr_bytes: 0,
      revision: 0
    };
    this.store.create(record);

    try {
      await this.runtime.spawnProcess({
        command: input.command,
        processHandle: record.process_handle,
        cwd: input.absoluteCwd,
        timeoutMs: input.timeoutMs,
        callbacks: {
          onOutput: (stream, chunk, capReached) => {
            this.store.appendOutput(jobId, stream, chunk, capReached);
          },
          onExit: result => {
            if (result.stdout) {
              this.store.appendOutput(jobId, "stdout", Buffer.from(result.stdout));
            }
            if (result.stderr) {
              this.store.appendOutput(jobId, "stderr", Buffer.from(result.stderr));
            }
            const current = this.store.get(jobId);
            this.store.update(jobId, {
              status: current.cancel_requested ? "cancelled" : "completed",
              exit_code: result.exitCode,
              stdout_cap_reached:
                current.stdout_cap_reached || result.stdoutCapReached,
              stderr_cap_reached:
                current.stderr_cap_reached || result.stderrCapReached,
              finished_at: new Date().toISOString()
            });
          },
          onLost: error => {
            const current = this.store.get(jobId);
            if (!this.store.isTerminal(current.status)) {
              this.store.update(jobId, {
                status: "orphaned",
                error: error.message,
                finished_at: new Date().toISOString()
              });
            }
          }
        }
      });

      const current = this.store.get(jobId);
      if (current.status === "starting") {
        this.store.update(jobId, { status: "running" });
      }
    } catch (error) {
      const current = this.store.get(jobId);
      if (!this.store.isTerminal(current.status)) {
        this.store.update(jobId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          finished_at: new Date().toISOString()
        });
      }
    }

    return this.store.view(this.store.get(jobId));
  }

  get(jobId: string): JobView {
    return this.store.view(this.store.get(jobId));
  }

  async wait(
    jobId: string,
    afterRevision: number | undefined,
    waitMs: number
  ): Promise<JobView> {
    if (afterRevision === undefined) return this.get(jobId);
    return this.store.waitForRevision(jobId, afterRevision, waitMs);
  }

  readOutput(
    jobId: string,
    stream: "stdout" | "stderr",
    offset: number,
    maxBytes: number
  ) {
    return this.store.readOutput(jobId, stream, offset, maxBytes);
  }

  list(limit = 20): JobView[] {
    return this.store.list(limit);
  }

  async cancel(jobId: string): Promise<JobView> {
    const job = this.store.get(jobId);
    if (this.store.isTerminal(job.status)) return this.store.view(job);

    this.store.update(jobId, {
      status: "cancelling",
      cancel_requested: true,
      error: undefined
    });

    try {
      await this.runtime.killProcess(job.process_handle);
    } catch (error) {
      const current = this.store.get(jobId);
      if (!this.store.isTerminal(current.status)) {
        this.store.update(jobId, {
          error: `cancel request failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      throw error;
    }

    // process/kill acknowledges the request before process/exited may arrive.
    // Give the app-server a short window to deliver the terminal notification so
    // callers normally receive "cancelled" rather than a transient "cancelling".
    const deadline = Date.now() + 5_000;
    let current = this.store.get(jobId);
    while (!this.store.isTerminal(current.status) && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const revision = current.revision;
      await this.store.waitForRevision(jobId, revision, Math.min(remaining, 1_000));
      current = this.store.get(jobId);
    }

    return this.store.view(current);
  }
}
