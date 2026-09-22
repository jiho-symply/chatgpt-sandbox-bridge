import { spawnSync } from "node:child_process";
import {
  McpServer,
  ResourceTemplate
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexRuntime } from "./codex-runtime.js";
import type { Config } from "./config.js";
import type { FileBridge } from "./files.js";
import type { JobManager } from "./jobs.js";
import type { Workspace } from "./workspace.js";

function result(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data
  };
}

const fileParam = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
});

export function createMcpServer(
  config: Config,
  workspace: Workspace,
  runtime: CodexRuntime,
  jobs: JobManager,
  files: FileBridge
): McpServer {
  const server = new McpServer(
    { name: "chatgpt-sandbox-bridge", version: "0.3.0" },
    {
      instructions: [
        "This app exposes a user-provided execution environment; it does not create or configure that environment.",
        "ChatGPT is the reasoning/coding agent; Codex app-server is only an execution harness.",
        "Use run for commands expected to finish quickly.",
        "Use start_job for ML, optimization, builds, servers, or other potentially long commands.",
        "For a long job, call get_job with the last revision and wait_ms <= 10000; do not keep one ChatGPT turn polling indefinitely.",
        "Use read_job_output with byte offsets for incremental logs.",
        "Use import_files for ChatGPT attachments and export_file for workspace artifacts.",
        "All cwd/path values are relative to the configured workspace."
      ].join(" ")
    }
  );

  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  };

  const action = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true
  };

  server.registerResource(
    "sandbox-artifact",
    new ResourceTemplate("sandbox://artifact/{id}", { list: undefined }),
    {
      title: "Workspace artifact",
      description: "A file exported from the user-provided execution environment.",
      mimeType: "application/octet-stream"
    },
    async (uri, variables) => {
      const artifact = files.readArtifact(String(variables.id));
      return {
        contents: [{
          uri: uri.href,
          mimeType: artifact.mime_type,
          blob: artifact.blob
        }]
      };
    }
  );

  server.registerTool(
    "status",
    {
      description: "Inspect bridge, Codex runtime, configured workspace, execution policy, and recent jobs.",
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
        bridge_version: "0.3.0",
        codex: (version.stdout || version.stderr || "").trim() || null,
        runtime: runtime.status(),
        workspace: workspace.root,
        state_dir: config.stateDir,
        environment_provider: "user",
        command_policy: config.sandboxMode,
        network_declared: config.networkEnabled,
        long_jobs: config.longJobsEnabled,
        recent_jobs: jobs.list(10)
      });
    }
  );

  server.registerTool(
    "run",
    {
      description:
        "Run one exact argv command expected to finish quickly in the configured environment. " +
        "For ML training, optimization, builds, servers, or uncertain duration use start_job instead.",
      inputSchema: {
        command: z.array(z.string().max(32_768)).min(1).max(256),
        cwd: z.string().max(4096).default("."),
        timeout_ms: z.number().int().positive().optional()
      },
      annotations: {
        ...action,
        idempotentHint: false
      }
    },
    async ({ command, cwd, timeout_ms }) => {
      const timeoutMs = Math.min(
        timeout_ms ?? config.defaultRunTimeoutMs,
        config.maxRunTimeoutMs
      );
      const execution = await jobs.run({
        command,
        cwd: workspace.resolveExistingDirectory(cwd),
        timeoutMs
      });
      return result({
        exit_code: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr
      });
    }
  );

  server.registerTool(
    "start_job",
    {
      description:
        "Start a long-running exact argv process in the user-provided environment and return after it starts. " +
        "Use get_job and read_job_output later. Omit timeout_ms for no process timeout.",
      inputSchema: {
        command: z.array(z.string().max(32_768)).min(1).max(256),
        cwd: z.string().max(4096).default("."),
        timeout_ms: z.number().int().positive().nullable().optional(),
        request_id: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/)
      },
      annotations: {
        ...action,
        idempotentHint: true
      }
    },
    async ({ command, cwd, timeout_ms, request_id }) => {
      const timeoutMs = timeout_ms === undefined ? null : timeout_ms;
      if (timeoutMs !== null && timeoutMs > config.maxJobTimeoutMs) {
        throw new Error("timeout_ms exceeds CSB_MAX_JOB_TIMEOUT_MS");
      }
      const absoluteCwd = workspace.resolveExistingDirectory(cwd);
      return result(await jobs.start({
        requestId: request_id,
        command,
        cwd,
        absoluteCwd,
        timeoutMs
      }) as unknown as Record<string, unknown>);
    }
  );

  server.registerTool(
    "get_job",
    {
      description:
        "Read a job state. To wait efficiently, pass the last seen after_revision and wait_ms up to 10000. " +
        "The call returns when the revision changes, the job becomes terminal, or the wait expires.",
      inputSchema: {
        job_id: z.string().uuid(),
        after_revision: z.number().int().min(0).optional(),
        wait_ms: z.number().int().min(0).max(10_000).default(0)
      },
      annotations: read
    },
    async ({ job_id, after_revision, wait_ms }) =>
      result(await jobs.wait(job_id, after_revision, wait_ms) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "read_job_output",
    {
      description:
        "Read an incremental slice of stdout or stderr for a job. " +
        "Pass next_offset from the previous call to continue without repeating logs.",
      inputSchema: {
        job_id: z.string().uuid(),
        stream: z.enum(["stdout", "stderr"]).default("stdout"),
        offset: z.number().int().min(0).default(0),
        max_bytes: z.number().int().positive().optional()
      },
      annotations: read
    },
    async ({ job_id, stream, offset, max_bytes }) =>
      result(jobs.readOutput(
        job_id,
        stream,
        offset,
        Math.min(max_bytes ?? config.maxReadBytes, config.maxReadBytes)
      ))
  );

  server.registerTool(
    "list_jobs",
    {
      description: "List recent durable jobs and their current states.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20)
      },
      annotations: read
    },
    async ({ limit }) => result({ jobs: jobs.list(limit) })
  );

  server.registerTool(
    "cancel_job",
    {
      description: "Request termination of one running long job.",
      inputSchema: { job_id: z.string().uuid() },
      annotations: {
        ...action,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async ({ job_id }) =>
      result(await jobs.cancel(job_id) as unknown as Record<string, unknown>)
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read bounded UTF-8 text from a workspace file. Use offset to continue a truncated read.",
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

  server.registerTool(
    "import_files",
    {
      title: "Import ChatGPT files",
      description:
        "Copy one or more user-provided ChatGPT attachments into the configured workspace.",
      inputSchema: {
        files: z.array(fileParam).min(1).max(10),
        destination_dir: z.string().min(1).max(4096).default("imports")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false
      },
      _meta: {
        "openai/fileParams": ["files"],
        "openai/toolInvocation/invoking": "Importing files",
        "openai/toolInvocation/invoked": "Files imported"
      }
    },
    async ({ files: inputFiles, destination_dir }) =>
      result({ files: await files.importFiles(inputFiles, destination_dir) })
  );

  server.registerTool(
    "export_file",
    {
      title: "Export workspace file",
      description:
        "Return a workspace file as an MCP resource link so ChatGPT can fetch or download the artifact.",
      inputSchema: {
        path: z.string().min(1).max(4096)
      },
      annotations: read,
      _meta: {
        "openai/toolInvocation/invoking": "Preparing file",
        "openai/toolInvocation/invoked": "File ready"
      }
    },
    async ({ path }) => {
      const artifact = files.exportFile(path);
      return {
        structuredContent: artifact,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(artifact, null, 2)
          },
          {
            type: "resource_link" as const,
            uri: artifact.uri,
            name: artifact.name,
            mimeType: artifact.mime_type,
            size: artifact.size,
            title: artifact.name
          }
        ]
      };
    }
  );

  return server;
}
