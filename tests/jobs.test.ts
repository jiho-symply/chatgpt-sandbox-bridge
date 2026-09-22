import { describe, expect, it } from "vitest";
import type { CodexExecutor } from "../src/codex-executor.js";
import { JobManager } from "../src/jobs.js";

describe("JobManager", () => {
  it("deduplicates an identical request_id", async () => {
    let calls = 0;
    const executor = {
      exec: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    } as unknown as CodexExecutor;

    const jobs = new JobManager(executor, 10);
    const first = jobs.start({
      requestId: "request-001",
      command: ["echo", "ok"],
      cwd: "/workspace",
      timeoutMs: 1000
    });
    const second = jobs.start({
      requestId: "request-001",
      command: ["echo", "ok"],
      cwd: "/workspace",
      timeoutMs: 1000
    });

    expect(second.job_id).toBe(first.job_id);
    const final = await jobs.get(first.job_id, 1000);
    expect(final.status).toBe("completed");
    expect(final.stdout).toBe("ok");
    expect(calls).toBe(1);
  });

  it("rejects request_id reuse with different content", () => {
    const executor = {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    } as unknown as CodexExecutor;

    const jobs = new JobManager(executor, 10);
    jobs.start({
      requestId: "request-002",
      command: ["echo", "a"],
      cwd: "/workspace",
      timeoutMs: 1000
    });

    expect(() => jobs.start({
      requestId: "request-002",
      command: ["echo", "b"],
      cwd: "/workspace",
      timeoutMs: 1000
    })).toThrow(/different content/);
  });
});
