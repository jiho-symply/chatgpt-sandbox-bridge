import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRuntime } from "../dist/codex-runtime.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-runtime-smoke-"));

const config = {
  host: "127.0.0.1",
  port: 8787,
  workspaceRoot: root,
  stateDir: path.join(root, "state"),
  codexBin: "codex",
  sandboxMode: "externalSandbox",
  networkEnabled: false,
  longJobsEnabled: true,
  defaultRunTimeoutMs: 10_000,
  maxRunTimeoutMs: 10_000,
  maxJobTimeoutMs: 60_000,
  maxJobs: 10,
  maxReadBytes: 1_048_576,
  maxImportBytes: 1_048_576,
  maxExportBytes: 1_048_576
};

const runtime = new CodexRuntime(config);

try {
  const short = await runtime.runCommand({
    command: ["sh", "-lc", "printf short-ok"],
    cwd: root,
    timeoutMs: 10_000
  });

  if (short.exitCode !== 0 || short.stdout !== "short-ok") {
    throw new Error(
      `command/exec smoke failed: exit=${short.exitCode} stdout=${JSON.stringify(short.stdout)} stderr=${JSON.stringify(short.stderr)}`
    );
  }

  let stdout = "";
  let stderr = "";

  const exited = new Promise((resolve, reject) => {
    runtime.spawnProcess({
      command: ["sh", "-lc", "printf long-ok"],
      processHandle: "runtime-smoke",
      cwd: root,
      timeoutMs: 10_000,
      callbacks: {
        onOutput(stream, chunk) {
          if (stream === "stdout") stdout += chunk.toString("utf8");
          else stderr += chunk.toString("utf8");
        },
        onExit(result) {
          resolve(result);
        },
        onLost(error) {
          reject(error);
        }
      }
    }).catch(reject);
  });

  const result = await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("process/spawn smoke timed out")), 15_000)
    )
  ]);

  if (result.exitCode !== 0 || stdout !== "long-ok" || stderr !== "") {
    throw new Error(
      `process/spawn smoke failed: exit=${result.exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`
    );
  }

  console.log("CODEX_RUNTIME_SMOKE_OK");
} finally {
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}
