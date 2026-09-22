import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Config } from "./config.js";

interface RpcEnvelope {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessCallbacks {
  onOutput(stream: "stdout" | "stderr", chunk: Buffer, capReached: boolean): void;
  onExit(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    stdoutCapReached: boolean;
    stderrCapReached: boolean;
  }): void;
  onLost(error: Error): void;
}

function runtimeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "CSB_BEARER_TOKEN",
    "CONTROL_PLANE_API_KEY",
    "OPENAI_ADMIN_KEY",
    "CLOUDFLARED_TUNNEL_TOKEN"
  ]) {
    delete env[key];
  }
  return env;
}

export class CodexRuntime {
  private proc?: ChildProcessWithoutNullStreams;
  private rl?: readline.Interface;
  private startPromise?: Promise<void>;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  private readonly processes = new Map<string, ProcessCallbacks>();
  private diagnostics: string[] = [];

  constructor(private readonly config: Config) {}

  status() {
    return {
      running: Boolean(this.proc && !this.proc.killed && this.initialized),
      pid: this.proc?.pid ?? null,
      active_processes: this.processes.size,
      diagnostics: this.diagnostics.slice(-10)
    };
  }

  async runCommand(input: {
    command: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<ExecResult> {
    if (input.command.length === 0) throw new Error("command must not be empty");
    const sandboxPolicy = this.config.sandboxMode === "externalSandbox"
      ? {
          type: "externalSandbox",
          networkAccess: this.config.networkEnabled ? "enabled" : "restricted"
        }
      : { type: "workspaceWrite" };

    const result = await this.request<ExecResult>("command/exec", {
      command: input.command,
      cwd: input.cwd,
      sandboxPolicy,
      timeoutMs: input.timeoutMs
    });

    return {
      exitCode: Number(result.exitCode),
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? "")
    };
  }

  async spawnProcess(input: {
    command: string[];
    processHandle: string;
    cwd: string;
    timeoutMs: number | null;
    callbacks: ProcessCallbacks;
  }): Promise<void> {
    if (input.command.length === 0) throw new Error("command must not be empty");
    await this.ensureStarted();
    if (this.processes.has(input.processHandle)) {
      throw new Error(`process handle already active: ${input.processHandle}`);
    }

    this.processes.set(input.processHandle, input.callbacks);
    try {
      await this.requestStarted<Record<string, never>>("process/spawn", {
        command: input.command,
        processHandle: input.processHandle,
        cwd: input.cwd,
        tty: false,
        streamStdin: false,
        streamStdoutStderr: true,
        outputBytesCap: null,
        timeoutMs: input.timeoutMs
      });
    } catch (error) {
      this.processes.delete(input.processHandle);
      throw error;
    }
  }

  async killProcess(processHandle: string): Promise<void> {
    await this.request<Record<string, never>>("process/kill", { processHandle });
  }

  async close(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    this.initialized = false;
    this.rl?.close();
    this.rl = undefined;
    if (proc && !proc.killed) proc.kill();
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    return this.requestStarted<T>(method, params);
  }

  private requestStarted<T>(method: string, params: unknown): Promise<T> {
    if (!this.proc || !this.initialized) {
      return Promise.reject(new Error("codex app-server is not initialized"));
    }
    return this.rpcCall<T>(method, params);
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed && this.initialized) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = undefined;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    const proc = spawn(this.config.codexBin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: runtimeEnv()
    });
    this.proc = proc;
    this.initialized = false;
    this.diagnostics = [];

    proc.stderr.on("data", chunk => {
      const text = Buffer.from(chunk).toString("utf8").trim();
      if (!text) return;
      this.diagnostics.push(text);
      if (this.diagnostics.length > 50) this.diagnostics.shift();
    });

    const rl = readline.createInterface({ input: proc.stdout });
    this.rl = rl;
    rl.on("line", line => this.handleLine(proc, line));

    proc.once("error", error => this.handleExit(proc, error));
    proc.once("exit", (code, signal) => {
      this.handleExit(
        proc,
        new Error(`codex app-server exited (code=${code}, signal=${signal})`)
      );
    });

    await this.rpcCall("initialize", {
      clientInfo: {
        name: "chatgpt_sandbox_bridge",
        title: "ChatGPT Sandbox Bridge",
        version: "0.2.0"
      },
      capabilities: { experimentalApi: true }
    });

    if (this.proc !== proc) {
      throw new Error("codex app-server exited during initialization");
    }

    proc.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    this.initialized = true;
  }

  private rpcCall<T>(method: string, params: unknown): Promise<T> {
    const proc = this.proc;
    if (!proc || proc.killed) {
      return Promise.reject(new Error("codex app-server is not running"));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject
      });
      proc.stdin.write(JSON.stringify({ method, id, params }) + "\n");
    });
  }

  private handleLine(proc: ChildProcessWithoutNullStreams, line: string): void {
    if (proc !== this.proc) return;

    let message: RpcEnvelope;
    try {
      message = JSON.parse(line) as RpcEnvelope;
    } catch {
      return;
    }

    if (message.method) {
      this.handleServerMessage(proc, message);
      return;
    }

    if (typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);

    if (message.error) {
      waiter.reject(new Error(
        message.error.message ?? `Codex RPC error ${message.error.code ?? ""}`
      ));
    } else {
      waiter.resolve(message.result);
    }
  }

  private handleServerMessage(
    proc: ChildProcessWithoutNullStreams,
    message: RpcEnvelope
  ): void {
    if (message.method === "process/outputDelta") {
      const params = message.params as {
        processHandle?: string;
        stream?: "stdout" | "stderr";
        deltaBase64?: string;
        capReached?: boolean;
      };
      if (
        typeof params.processHandle === "string" &&
        (params.stream === "stdout" || params.stream === "stderr") &&
        typeof params.deltaBase64 === "string"
      ) {
        this.processes.get(params.processHandle)?.onOutput(
          params.stream,
          Buffer.from(params.deltaBase64, "base64"),
          params.capReached === true
        );
      }
      return;
    }

    if (message.method === "process/exited") {
      const params = message.params as {
        processHandle?: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
        stdoutCapReached?: boolean;
        stderrCapReached?: boolean;
      };
      if (typeof params.processHandle !== "string") return;
      const callbacks = this.processes.get(params.processHandle);
      this.processes.delete(params.processHandle);
      callbacks?.onExit({
        exitCode: Number(params.exitCode ?? -1),
        stdout: String(params.stdout ?? ""),
        stderr: String(params.stderr ?? ""),
        stdoutCapReached: params.stdoutCapReached === true,
        stderrCapReached: params.stderrCapReached === true
      });
      return;
    }

    if (message.id !== undefined) {
      proc.stdin.write(JSON.stringify({
        id: message.id,
        error: { code: -32601, message: "Unsupported client method" }
      }) + "\n");
    }
  }

  private handleExit(proc: ChildProcessWithoutNullStreams, error: Error): void {
    if (proc !== this.proc) return;
    this.proc = undefined;
    this.initialized = false;
    this.rl?.close();
    this.rl = undefined;

    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();

    for (const callbacks of this.processes.values()) callbacks.onLost(error);
    this.processes.clear();
  }
}
