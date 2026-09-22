import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CodexRuntime } from "./codex-runtime.js";
import { loadConfig } from "./config.js";
import { FileBridge } from "./files.js";
import { JobStore } from "./job-store.js";
import { JobManager } from "./jobs.js";
import { createMcpServer } from "./mcp.js";
import { Workspace } from "./workspace.js";

const config = loadConfig();
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
const token = process.env.CSB_BEARER_TOKEN;

if (config.host !== "127.0.0.1" && config.host !== "::1" && !token) {
  throw new Error("CSB_BEARER_TOKEN is required when binding beyond loopback");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "chatgpt-sandbox-bridge",
    version: "0.2.0",
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
    `chatgpt-sandbox-bridge listening on http://${config.host}:${config.port}/mcp\n` +
    `workspace: ${workspace.root}\n` +
    `state: ${config.stateDir}\n` +
    `sandbox: ${config.sandboxMode}\n` +
    `long jobs: ${config.longJobsEnabled}`
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  http.close();
  await runtime.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
