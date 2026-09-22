import fs from "node:fs";
import path from "node:path";

export type JobStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

export interface JobRecord {
  job_id: string;
  request_id: string;
  process_handle: string;
  status: JobStatus;
  command: string[];
  cwd: string;
  timeout_ms: number | null;
  created_at: string;
  updated_at: string;
  finished_at?: string;
  exit_code?: number;
  error?: string;
  cancel_requested?: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_cap_reached?: boolean;
  stderr_cap_reached?: boolean;
  revision: number;
}

export type JobView = Omit<JobRecord, "process_handle">;

const terminal = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
  "orphaned"
]);

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly requestIds = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    readonly root: string,
    private readonly maxJobs: number
  ) {
    fs.mkdirSync(this.jobsDir(), { recursive: true, mode: 0o700 });
    this.load();
  }

  isTerminal(status: JobStatus): boolean {
    return terminal.has(status);
  }

  findByRequestId(requestId: string): JobRecord | undefined {
    const id = this.requestIds.get(requestId);
    return id ? this.jobs.get(id) : undefined;
  }

  create(record: JobRecord): JobRecord {
    this.prune();
    if (this.jobs.size >= this.maxJobs) {
      throw new Error("job history is full; remove old terminal jobs or raise CSB_MAX_JOBS");
    }
    this.jobs.set(record.job_id, record);
    this.requestIds.set(record.request_id, record.job_id);
    this.persist(record);
    return record;
  }

  get(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("unknown job_id");
    return job;
  }

  view(job: JobRecord): JobView {
    const { process_handle: _processHandle, ...view } = job;
    return { ...view, command: [...job.command] };
  }

  list(limit = 20): JobView[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map(job => this.view(job));
  }

  update(
    jobId: string,
    patch: Partial<Omit<JobRecord, "job_id" | "request_id" | "process_handle" | "revision">>
  ): JobRecord {
    const job = this.get(jobId);
    Object.assign(job, patch);
    job.updated_at = new Date().toISOString();
    job.revision += 1;
    this.persist(job);
    this.signal(jobId);
    return job;
  }

  appendOutput(
    jobId: string,
    stream: "stdout" | "stderr",
    chunk: Buffer,
    capReached = false
  ): JobRecord {
    const job = this.get(jobId);
    if (chunk.length > 0) {
      fs.appendFileSync(this.logPath(jobId, stream), chunk);
      if (stream === "stdout") job.stdout_bytes += chunk.length;
      else job.stderr_bytes += chunk.length;
    }
    if (capReached) {
      if (stream === "stdout") job.stdout_cap_reached = true;
      else job.stderr_cap_reached = true;
    }
    job.updated_at = new Date().toISOString();
    job.revision += 1;
    this.persist(job);
    this.signal(jobId);
    return job;
  }

  readOutput(
    jobId: string,
    stream: "stdout" | "stderr",
    offset: number,
    maxBytes: number
  ) {
    const job = this.get(jobId);
    const file = this.logPath(jobId, stream);
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const safeOffset = Math.max(0, Math.min(offset, size));
    const length = Math.min(maxBytes, size - safeOffset);
    const buffer = Buffer.alloc(length);

    if (length > 0) {
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buffer, 0, length, safeOffset);
      } finally {
        fs.closeSync(fd);
      }
    }

    return {
      job_id: jobId,
      status: job.status,
      revision: job.revision,
      stream,
      offset: safeOffset,
      next_offset: safeOffset + length,
      bytes: length,
      available_bytes: size,
      has_more: safeOffset + length < size,
      terminal: terminal.has(job.status),
      text: buffer.toString("utf8")
    };
  }

  async waitForRevision(
    jobId: string,
    afterRevision: number,
    waitMs: number
  ): Promise<JobView> {
    let job = this.get(jobId);
    if (
      job.revision > afterRevision ||
      terminal.has(job.status) ||
      waitMs <= 0
    ) {
      return this.view(job);
    }

    await new Promise<void>(resolve => {
      const set = this.waiters.get(jobId) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.waiters.delete(jobId);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      set.add(done);
      this.waiters.set(jobId, set);
    });

    job = this.get(jobId);
    return this.view(job);
  }

  private load(): void {
    for (const name of fs.readdirSync(this.jobsDir())) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.jobsDir(), name), "utf8");
        const job = JSON.parse(raw) as JobRecord;
        if (!job.job_id || !job.request_id) continue;

        if (["starting", "running", "cancelling"].includes(job.status)) {
          job.status = "orphaned";
          job.error =
            "Bridge restarted while this connection-scoped process was active; process ownership was lost.";
          job.finished_at = new Date().toISOString();
          job.updated_at = job.finished_at;
          job.revision = Number(job.revision ?? 0) + 1;
          this.persist(job);
        }

        this.jobs.set(job.job_id, job);
        this.requestIds.set(job.request_id, job.job_id);
      } catch {
        // Ignore malformed state rather than blocking bridge startup.
      }
    }
  }

  private prune(): void {
    if (this.jobs.size < this.maxJobs) return;
    const removable = [...this.jobs.values()]
      .filter(job => terminal.has(job.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    while (this.jobs.size >= this.maxJobs && removable.length > 0) {
      const job = removable.shift()!;
      this.jobs.delete(job.job_id);
      this.requestIds.delete(job.request_id);
      for (const file of [
        this.metaPath(job.job_id),
        this.logPath(job.job_id, "stdout"),
        this.logPath(job.job_id, "stderr")
      ]) {
        fs.rmSync(file, { force: true });
      }
    }
  }

  private signal(jobId: string): void {
    const set = this.waiters.get(jobId);
    if (!set) return;
    for (const wake of [...set]) wake();
  }

  private persist(job: JobRecord): void {
    fs.mkdirSync(this.jobsDir(), { recursive: true, mode: 0o700 });
    const target = this.metaPath(job.job_id);
    const temp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(job, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600
    });
    fs.renameSync(temp, target);
  }

  private jobsDir(): string {
    return path.join(this.root, "jobs");
  }

  private metaPath(jobId: string): string {
    return path.join(this.jobsDir(), `${jobId}.json`);
  }

  private logPath(jobId: string, stream: "stdout" | "stderr"): string {
    return path.join(this.jobsDir(), `${jobId}.${stream}.log`);
  }
}
