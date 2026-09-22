#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CodexRuntime } from "./codex-runtime.js";
import { loadConfig } from "./config.js";
import { FileBridge } from "./files.js";
import { JobStore } from "./job-store.js";
import { JobManager } from "./jobs.js";
import { createMcpServer } from "./mcp.js";
import { Workspace } from "./workspace.js";

const VERSION = "0.3.0";
const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  process.stdout.write([
    "chatgpt-sandbox-bridge",
    "",
    "Usage:",
    "  chatgpt-sandbox-bridge --stdio    Run as a stdio MCP server (recommended with tunnel-client)",
    "  chatgpt-sandbox-bridge --http     Run Streamable HTTP MCP server (default)",
    "  chatgpt-sandbox-bridge --doctor   Check the current execution environment",
    "  chatgpt-sandbox-bridge --version  Print version",
    "",
    "The bridge does not create a container, VM, CUDA environment, or Python environment.",
    "It exposes the environment in which this command is executed.",
    ""
  ].join("\n"));
  process.exit(0);
}

if (args.has("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const config = loadConfig();

function commandProbe(command: string, commandArgs: string[] = ["--version"]) {
  const probe = spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout: 5000
  });
  return {
    available: probe.status === 0,
    output: (probe.stdout || probe.stderr || "").trim() || null
  };
}

if (args.has("--doctor")) {
  let workspaceOk = false;
  let workspaceError: string | null = null;
  let stateOk = false;
  let stateError: string | null = null;

  try {
    const workspace = new Workspace(config.workspaceRoot);
    fs.accessSync(workspace.root, fs.constants.R_OK | fs.constants.W_OK);
    workspaceOk = true;
  } catch (error) {
    workspaceError = error instanceof Error ? error.message : String(error);
  }

  try {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    fs.accessSync(config.stateDir, fs.constants.R_OK | fs.constants.W_OK);
    stateOk = true;
  } catch (error) {
    stateError = error instanceof Error ? error.message : String(error);
  }

  const report = {
    ok: workspaceOk && stateOk && commandProbe(config.codexBin).available,
    bridge_version: VERSION,
    environment: {
      platform: process.platform,
      arch: process.arch,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      cwd: process.cwd()
    },
    workspace: {
      path: config.workspaceRoot,
      writable: workspaceOk,
      error: workspaceError
    },
    state: {
      path: config.stateDir,
      writable: stateOk,
      error: stateError
    },
    execution: {
      short_command_policy: config.sandboxMode,
      network_declared: config.networkEnabled,
      long_jobs_enabled: config.longJobsEnabled
    },
    tools: {
      codex: commandProbe(config.codexBin),
      node: commandProbe(process.execPath, ["--version"]),
      python3: commandProbe("python3"),
      git: commandProbe("git"),
      nvidia_smi: commandProbe("nvidia-smi")
    }
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}

if (args.has("--stdio") && args.has("--http")) {
  throw new Error("Choose only one transport: --stdio or --http");
}

const workspace = new Workspace(config.workspaceRoot);
const runtime = new CodexRuntime(config);
const store = new JobStore(config.stateDir, config.maxJobs);
const jobs = new JobManager(
  runtime,
  store,
  config.longJobsEnabled,
  config.maxJobTimeoutMs
);
const files = new FileBridge(
  workspace,
  config.maxImportBytes,
  config.maxExportBytes
);

let shuttingDown = false;
let stdioServer: ReturnType<typeof createMcpServer> | undefined;
let closeHttp: (() => void) | undefined;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  closeHttp?.();
  if (stdioServer) await stdioServer.close();
  await runtime.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

if (args.has("--stdio")) {
  stdioServer = createMcpServer(config, workspace, runtime, jobs, files);
  const transport = new StdioServerTransport();

  console.error(
    `chatgpt-sandbox-bridge ${VERSION} starting on stdio\n` +
    `workspace: ${workspace.root}\n` +
    `state: ${config.stateDir}\n` +
    `command policy: ${config.sandboxMode}\n` +
    `long jobs: ${config.longJobsEnabled}`
  );

  await stdioServer.connect(transport);
} else {
  const token = process.env.CSB_BEARER_TOKEN;
  if (config.host !== "127.0.0.1" && config.host !== "::1" && !token) {
    throw new Error("CSB_BEARER_TOKEN is required when HTTP binds beyond loopback");
  }

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "chatgpt-sandbox-bridge",
      version: VERSION,
      runtime: runtime.status()
    });
  });

  app.all("/mcp", async (req, res) => {
    if (token) {
      const auth = req.header("authorization");
      if (auth !== `Bearer ${token}`) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    const server = createMcpServer(config, workspace, runtime, jobs, files);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request failed" });
      }
    }
  });

  const http = app.listen(config.port, config.host, () => {
    console.error(
      `chatgpt-sandbox-bridge ${VERSION} listening on http://${config.host}:${config.port}/mcp\n` +
      `workspace: ${workspace.root}\n` +
      `state: ${config.stateDir}\n` +
      `command policy: ${config.sandboxMode}\n` +
      `long jobs: ${config.longJobsEnabled}`
    );
  });

  closeHttp = () => http.close();
}
