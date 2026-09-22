import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { JobManager } from "./jobs.js";
import type { Workspace } from "./workspace.js";

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>
  };
}

export function createMcpServer(
  config: Config,
  workspace: Workspace,
  jobs: JobManager
): McpServer {
  const server = new McpServer(
    { name: "chatgpt-sandbox-bridge", version: "0.1.0" },
    {
      instructions:
        "This app provides one user-authorized isolated workspace. " +
        "Use execute to run exact argv commands chosen by ChatGPT. " +
        "execute starts a job and returns immediately; poll get_result for completion. " +
        "Do not claim a command ran unless get_result reports completed. " +
        "All cwd/path values are relative to the configured workspace."
    }
  );

  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  };

  server.registerTool(
    "status",
    {
      description: "Inspect bridge, Codex runtime, workspace, sandbox, and recent jobs.",
      inputSchema: {},
      annotations: read
    },
    async () => {
      const version = spawnSync(config.codexBin, ["--version"], {
        encoding: "utf8",
        timeout: 5000
      });
      return result({
        ok: version.status === 0,
        codex: (version.stdout || version.stderr || "").trim() || null,
        workspace: workspace.root,
        sandbox_mode: config.sandboxMode,
        network: config.networkEnabled,
        recent_jobs: jobs.recent(10)
      });
    }
  );

  server.registerTool(
    "execute",
    {
      description:
        "Execute an exact argv command inside the configured isolated workspace. " +
        "This is an action: it may create, modify, or delete files and may run arbitrary code within the sandbox. " +
        "Returns a durable job_id; use get_result to obtain stdout, stderr, and exit code.",
      inputSchema: {
        command: z.array(z.string().max(32_768)).min(1).max(256),
        cwd: z.string().max(4096).default("."),
        timeout_ms: z.number().int().positive().optional(),
        request_id: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true
      }
    },
    async ({ command, cwd, timeout_ms, request_id }) => {
      const absoluteCwd = workspace.resolve(cwd);
      const timeoutMs = Math.min(
        timeout_ms ?? config.defaultTimeoutMs,
        config.maxTimeoutMs
      );
      return result(jobs.start({
        requestId: request_id,
        command,
        cwd: absoluteCwd,
        timeoutMs
      }));
    }
  );

  server.registerTool(
    "get_result",
    {
      description:
        "Read one exact execution job. Optionally wait up to 20 seconds for it to finish.",
      inputSchema: {
        job_id: z.string().uuid(),
        wait_ms: z.number().int().min(0).max(20_000).default(0)
      },
      annotations: read
    },
    async ({ job_id, wait_ms }) => result(await jobs.get(job_id, wait_ms))
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read bounded UTF-8 text from a file inside the configured workspace. " +
        "Use offset to continue a truncated read.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        offset: z.number().int().min(0).default(0),
        max_bytes: z.number().int().positive().optional()
      },
      annotations: read
    },
    async ({ path, offset, max_bytes }) => result(
      workspace.readText(
        path,
        Math.min(max_bytes ?? config.maxReadBytes, config.maxReadBytes),
        offset
      )
    )
  );

  return server;
}
