import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { CodexExecutor } from "./codex-executor.js";
import { JobManager } from "./jobs.js";
import { createMcpServer } from "./mcp.js";
import { Workspace } from "./workspace.js";

const config = loadConfig();
const workspace = new Workspace(config.workspaceRoot);
const executor = new CodexExecutor(config);
const jobs = new JobManager(executor, config.maxJobs);
const token = process.env.CSB_BEARER_TOKEN;

if (config.host !== "127.0.0.1" && config.host !== "::1" && !token) {
  throw new Error("CSB_BEARER_TOKEN is required when binding beyond loopback");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "chatgpt-sandbox-bridge", version: "0.1.0" });
});

app.all("/mcp", async (req, res) => {
  if (token) {
    const auth = req.header("authorization");
    if (auth !== `Bearer ${token}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  const server = createMcpServer(config, workspace, jobs);
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

app.listen(config.port, config.host, () => {
  console.error(
    `chatgpt-sandbox-bridge listening on http://${config.host}:${config.port}/mcp\n` +
    `workspace: ${workspace.root}\n` +
    `sandbox: ${config.sandboxMode}`
  );
});
