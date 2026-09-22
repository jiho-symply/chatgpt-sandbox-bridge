import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexRuntime, ProcessCallbacks } from "../src/codex-runtime.js";
import { JobStore } from "../src/job-store.js";
import { JobManager } from "../src/jobs.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-jobs-"));
  roots.push(root);

  let spawnCalls = 0;
  const killedHandles: string[] = [];
  let callbacks: ProcessCallbacks | undefined;
  const runtime = {
    runCommand: async () => ({ exitCode: 0, stdout: "short", stderr: "" }),
    spawnProcess: async (input: { callbacks: ProcessCallbacks }) => {
      spawnCalls += 1;
      callbacks = input.callbacks;
    },
    killProcess: async (processHandle: string) => {
      killedHandles.push(processHandle);
      callbacks?.onExit({
        exitCode: 137,
        stdout: "",
        stderr: "",
        stdoutCapReached: false,
        stderrCapReached: false
      });
    },
  } as unknown as CodexRuntime;

  const store = new JobStore(root, 20);
  const manager = new JobManager(runtime, store, true, 60_000);

  return {
    root,
    store,
    manager,
    spawnCalls: () => spawnCalls,
    killedHandles: () => [...killedHandles],
    callbacks: () => callbacks
  };
}

describe("JobManager", () => {
  it("deduplicates an identical request_id", async () => {
    const f = fixture();

    const first = await f.manager.start({
      requestId: "request-001",
      command: ["python3", "train.py"],
      cwd: ".",
      absoluteCwd: "/workspace",
      timeoutMs: null
    });
    const second = await f.manager.start({
      requestId: "request-001",
      command: ["python3", "train.py"],
      cwd: ".",
      absoluteCwd: "/workspace",
      timeoutMs: null
    });

    expect(second.job_id).toBe(first.job_id);
    expect(f.spawnCalls()).toBe(1);
    expect(first.status).toBe("running");
  });

  it("rejects request_id reuse with different content", async () => {
    const f = fixture();

    await f.manager.start({
      requestId: "request-002",
      command: ["echo", "a"],
      cwd: ".",
      absoluteCwd: "/workspace",
      timeoutMs: null
    });

    await expect(f.manager.start({
      requestId: "request-002",
      command: ["echo", "b"],
      cwd: ".",
      absoluteCwd: "/workspace",
      timeoutMs: null
    })).rejects.toThrow(/different content/);
  });

  it("streams output and records terminal status", async () => {
    const f = fixture();

    const job = await f.manager.start({
      requestId: "request-003",
      command: ["python3", "solve.py"],
      cwd: ".",
      absoluteCwd: "/workspace",
      timeoutMs: null
    });

    f.callbacks()?.onOutput("stdout", Buffer.from("node 1\n"), false);
    f.callbacks()?.onOutput("stdout", Buffer.from("optimal\n"), false);
    f.callbacks()?.onExit({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutCapReached: false,
      stderrCapReached: false
    });

    expect(f.manager.get(job.job_id).status).toBe("completed");
    const output = f.manager.readOutput(job.job_id, "stdout", 0, 1024);
    expect(output.text).toBe("node 1\noptimal\n");
    expect(output.terminal).toBe(true);
  });

  it("kills a running job and returns cancelled state", async () => {
    const f = fixture();

    const job = await f.manager.start({
      requestId: "request-cancel-001",
      command: ["sleep", "3600"],
      cwd: ".",
      absoluteCwd: "/workspace",
      timeoutMs: null
    });

    const cancelled = await f.manager.cancel(job.job_id);

    expect(f.killedHandles()).toHaveLength(1);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancel_requested).toBe(true);
    expect(cancelled.exit_code).toBe(137);
  });

  it("marks active jobs orphaned after bridge restart", async () => {
    const f = fixture();

    const job = await f.manager.start({
      requestId: "request-004",
      command: ["sleep", "3600"],
      cwd: ".",
      absoluteCwd: "/workspace",
      timeoutMs: null
    });
    expect(job.status).toBe("running");

    const reloaded = new JobStore(f.root, 20);
    const recovered = reloaded.get(job.job_id);
    expect(recovered.status).toBe("orphaned");
    expect(recovered.error).toMatch(/process ownership was lost/);
  });
});
