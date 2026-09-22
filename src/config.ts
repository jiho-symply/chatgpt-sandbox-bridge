import path from "node:path";

export type SandboxMode = "workspaceWrite" | "externalSandbox";

export interface Config {
  host: string;
  port: number;
  workspaceRoot: string;
  codexBin: string;
  sandboxMode: SandboxMode;
  networkEnabled: boolean;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxJobs: number;
  maxReadBytes: number;
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

  const defaultTimeoutMs = positiveInt("CSB_DEFAULT_TIMEOUT_MS", 120_000);
  const maxTimeoutMs = positiveInt("CSB_MAX_TIMEOUT_MS", 3_600_000);
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error("CSB_DEFAULT_TIMEOUT_MS cannot exceed CSB_MAX_TIMEOUT_MS");
  }

  return {
    host: process.env.CSB_HOST ?? "127.0.0.1",
    port: positiveInt("CSB_PORT", 8787),
    workspaceRoot: path.resolve(process.env.CSB_WORKSPACE_ROOT ?? process.cwd()),
    codexBin: process.env.CSB_CODEX_BIN ?? "codex",
    sandboxMode,
    networkEnabled: bool("CSB_NETWORK", false),
    defaultTimeoutMs,
    maxTimeoutMs,
    maxJobs: positiveInt("CSB_MAX_JOBS", 200),
    maxReadBytes: positiveInt("CSB_MAX_READ_BYTES", 1_048_576)
  };
}
