import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Config } from "./config.js";

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface ExecRequest {
  command: string[];
  cwd: string;
  timeoutMs: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function send(proc: ChildProcessWithoutNullStreams, message: unknown): void {
  proc.stdin.write(JSON.stringify(message) + "\n");
}

export class CodexExecutor {
  constructor(private readonly config: Config) {}

  async exec(request: ExecRequest): Promise<ExecResult> {
    if (request.command.length === 0) throw new Error("command must not be empty");

    const proc = spawn(this.config.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    const stderrChunks: Buffer[] = [];
    proc.stderr.on("data", chunk => stderrChunks.push(Buffer.from(chunk)));

    const rl = readline.createInterface({ input: proc.stdout });
    const pending = new Map<number, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>();

    let nextId = 1;
    let closedError: Error | null = null;

    const failAll = (error: Error) => {
      closedError = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };

    rl.on("line", line => {
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;

      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);

      if (message.error) {
        waiter.reject(new Error(message.error.message ?? `Codex RPC error ${message.error.code ?? ""}`));
      } else {
        waiter.resolve(message.result);
      }
    });

    proc.once("error", failAll);
    proc.once("exit", (code, signal) => {
      if (pending.size > 0) {
        const diagnostic = Buffer.concat(stderrChunks).toString("utf8").trim();
        failAll(new Error(
          `codex app-server exited before replying (code=${code}, signal=${signal})` +
          (diagnostic ? `: ${diagnostic}` : "")
        ));
      }
    });

    const call = <T>(method: string, params: unknown): Promise<T> => {
      if (closedError) return Promise.reject(closedError);
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: value => resolve(value as T), reject });
        send(proc, { method, id, params });
      });
    };

    try {
      await call("initialize", {
        clientInfo: {
          name: "chatgpt_sandbox_bridge",
          title: "ChatGPT Sandbox Bridge",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      });
      send(proc, { method: "initialized", params: {} });

      const sandboxPolicy = this.config.sandboxMode === "externalSandbox"
        ? {
            type: "externalSandbox",
            networkAccess: this.config.networkEnabled ? "enabled" : "restricted"
          }
        : { type: "workspaceWrite" };

      const result = await call<ExecResult>("command/exec", {
        command: request.command,
        cwd: request.cwd,
        sandboxPolicy,
        timeoutMs: request.timeoutMs
      });

      return {
        exitCode: Number(result.exitCode),
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? "")
      };
    } finally {
      rl.close();
      proc.kill();
    }
  }
}
