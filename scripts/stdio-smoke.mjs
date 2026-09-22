import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-stdio-smoke-"));
const state = path.join(root, ".state");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string")
);

Object.assign(env, {
  CSB_WORKSPACE_ROOT: root,
  CSB_STATE_DIR: state,
  CSB_SANDBOX_MODE: "externalSandbox",
  CSB_NETWORK: "false",
  CSB_LONG_JOBS: "true"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/cli.js", "--stdio"],
  env
});

const client = new Client({
  name: "chatgpt-sandbox-bridge-stdio-smoke",
  version: "1.0.0"
});

try {
  await client.connect(transport);

  const listed = await client.listTools();
  const names = new Set(listed.tools.map(tool => tool.name));
  for (const required of [
    "status",
    "run",
    "start_job",
    "get_job",
    "read_job_output",
    "list_jobs",
    "cancel_job",
    "read_file",
    "import_files",
    "export_file"
  ]) {
    if (!names.has(required)) throw new Error(`missing MCP tool: ${required}`);
  }

  const response = await client.callTool({
    name: "run",
    arguments: {
      command: ["sh", "-lc", "printf stdio-mcp-ok"],
      cwd: ".",
      timeout_ms: 10000
    }
  });

  const data = response.structuredContent;
  if (
    !data ||
    data.exit_code !== 0 ||
    data.stdout !== "stdio-mcp-ok" ||
    data.stderr !== ""
  ) {
    throw new Error(`stdio MCP run failed: ${JSON.stringify(data)}`);
  }

  console.log("STDIO_MCP_SMOKE_OK");
} finally {
  await client.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
