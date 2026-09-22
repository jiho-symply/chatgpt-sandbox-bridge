import os from "node:os";
import path from "node:path";

export type SandboxMode = "workspaceWrite" | "externalSandbox";

export interface Config {
  host: string;
  port: number;
  workspaceRoot: string;
  stateDir: string;
  codexBin: string;
  sandboxMode: SandboxMode;
  networkEnabled: boolean;
  longJobsEnabled: boolean;
  defaultRunTimeoutMs: number;
  maxRunTimeoutMs: number;
  maxJobTimeoutMs: number;
  maxJobs: number;
  maxReadBytes: number;
  maxImportBytes: number;
  maxExportBytes: number;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

export function loadConfig(): Config {
  const sandboxMode = (process.env.CSB_SANDBOX_MODE ?? "workspaceWrite") as SandboxMode;
  if (!["workspaceWrite", "externalSandbox"].includes(sandboxMode)) {
    throw new Error("CSB_SANDBOX_MODE must be workspaceWrite or externalSandbox");
  }

  const defaultRunTimeoutMs = positiveInt("CSB_DEFAULT_RUN_TIMEOUT_MS", 60_000);
  const maxRunTimeoutMs = positiveInt("CSB_MAX_RUN_TIMEOUT_MS", 120_000);
  if (defaultRunTimeoutMs > maxRunTimeoutMs) {
    throw new Error("CSB_DEFAULT_RUN_TIMEOUT_MS cannot exceed CSB_MAX_RUN_TIMEOUT_MS");
  }

  return {
    host: process.env.CSB_HOST ?? "127.0.0.1",
    port: positiveInt("CSB_PORT", 8787),
    workspaceRoot: path.resolve(process.env.CSB_WORKSPACE_ROOT ?? process.cwd()),
    stateDir: path.resolve(
      process.env.CSB_STATE_DIR ??
      path.join(os.homedir(), ".chatgpt-sandbox-bridge")
    ),
    codexBin: process.env.CSB_CODEX_BIN ?? "codex",
    sandboxMode,
    networkEnabled: bool("CSB_NETWORK", false),
    longJobsEnabled: bool("CSB_LONG_JOBS", false),
    defaultRunTimeoutMs,
    maxRunTimeoutMs,
    maxJobTimeoutMs: positiveInt("CSB_MAX_JOB_TIMEOUT_MS", 604_800_000),
    maxJobs: positiveInt("CSB_MAX_JOBS", 1000),
    maxReadBytes: positiveInt("CSB_MAX_READ_BYTES", 1_048_576),
    maxImportBytes: positiveInt("CSB_MAX_IMPORT_BYTES", 104_857_600),
    maxExportBytes: positiveInt("CSB_MAX_EXPORT_BYTES", 52_428_800)
  };
}
