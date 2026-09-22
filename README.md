# ChatGPT Sandbox Bridge

Give **ChatGPT Web Chat** an isolated computer it can use directly.

ChatGPT remains the only reasoning/coding agent. Codex is not asked to solve tasks, review code, or interpret natural-language instructions. The bridge uses only the Codex app-server execution APIs as a local process harness.

```text
ChatGPT Web Chat
        │
        │ MCP actions
        ▼
OpenAI Secure MCP Tunnel
        │
        ▼
chatgpt-sandbox-bridge
        │
        ├── short command ──> codex command/exec
        │
        ├── long job ───────> codex process/spawn
        │                       ├── stdout/stderr stream
        │                       └── process/exited
        │
        ├── durable job metadata + logs
        └── file import/export
                │
                ▼
        isolated Docker / VM
```

There is no Codex conversation, Codex thread, Codex turn, model selection, or second-agent reasoning in this project.

## What ChatGPT can do

| Tool | Type | Purpose |
| --- | --- | --- |
| `status` | read | Inspect bridge/runtime/isolation state and recent jobs |
| `run` | action | Run a short exact argv command |
| `start_job` | action | Start a long-running process and return immediately |
| `get_job` | read | Check/wait briefly for job state changes |
| `read_job_output` | read | Read incremental stdout/stderr using byte offsets |
| `list_jobs` | read | Find recent durable jobs |
| `cancel_job` | action | Terminate a running long job |
| `read_file` | read | Read bounded UTF-8 text from the workspace |
| `import_files` | action | Copy ChatGPT attachments into the workspace |
| `export_file` | read | Expose a workspace result as an MCP resource/artifact |

Action tools are deliberately declared as actions. They are **not** mislabeled as read-only to bypass ChatGPT permission controls.

## Long-running ML / solver jobs

Do not keep one ChatGPT response open for hours.

For short commands, ChatGPT uses:

```json
{
  "command": ["python3", "-m", "pytest", "-q"],
  "cwd": "."
}
```

through `run`.

For long or unpredictable commands, including PyTorch training, Gurobi/CPLEX solves, compilation, simulations, or servers, ChatGPT uses `start_job`:

```json
{
  "command": ["python3", "solve.py"],
  "cwd": ".",
  "timeout_ms": null,
  "request_id": "solve-20260922-001"
}
```

The call returns after the process starts:

```json
{
  "job_id": "...",
  "status": "running",
  "revision": 1,
  "stdout_bytes": 0,
  "stderr_bytes": 0
}
```

ChatGPT may briefly wait for a state change:

```json
{
  "job_id": "...",
  "after_revision": 1,
  "wait_ms": 10000
}
```

`get_job` is intentionally capped at **10 seconds per poll**. A ChatGPT response should not poll indefinitely. If a job is still running, the response can end; the process continues in the sandbox. A later chat turn can recover it through `list_jobs` / `get_job`.

Logs are incremental:

```json
{
  "job_id": "...",
  "stream": "stdout",
  "offset": 0,
  "max_bytes": 65536
}
```

The response returns `next_offset`. Pass that value on the next call to avoid rereading the same solver/training log.

### Persistence semantics

Job metadata and stdout/stderr logs live under `CSB_STATE_DIR` and survive ChatGPT turns and ordinary container recreation when the state volume is retained.

The actual Codex `process/spawn` handle is connection-scoped. If the bridge or Codex app-server restarts while a job is active, the bridge **does not pretend that it still owns the process**. The persisted job is marked `orphaned`.

For jobs that must survive bridge/container restarts as real running processes, add a dedicated external scheduler/runtime such as systemd, Slurm, Kubernetes Jobs, or a separate worker daemon. That is intentionally outside the v0.2 scope.

## File transfer

### ChatGPT attachment -> sandbox

`import_files` uses the ChatGPT Apps file-parameter contract. ChatGPT supplies temporary file references containing `download_url`, `file_id`, MIME type, and file name; the bridge downloads the file into the selected workspace directory.

Typical flow:

```text
user attaches data.csv
      │
      ▼
ChatGPT import_files
      │
      ▼
/workspace/imports/data.csv
      │
      ▼
Python / R / solver / compiler
```

The default maximum imported file size is 100 MiB per file.

### Sandbox -> ChatGPT

`export_file` converts a workspace file into an MCP `resource_link`:

```text
/workspace/results/solution.xlsx
      │
      ▼
export_file
      │
      ▼
sandbox://artifact/...
      │
      ▼
MCP resources/read
      │
      ▼
ChatGPT host
```

Binary data is fetched only when the host reads the resource; it is not dumped into the model prompt as text.

Useful outputs include:

- CSV / XLSX results
- PDFs
- PNG/JPEG plots
- Gurobi `.sol`, `.lp`, `.mps`
- ZIP/TAR archives
- model/checkpoint files within the configured export limit

The default export limit is 50 MiB. Resource-link rendering/download behavior is ultimately controlled by the ChatGPT host.

## Why Codex is still present

Codex is only the local execution harness:

- `command/exec` for short sandboxed commands
- `process/spawn` for long processes
- `process/outputDelta` for streamed stdout/stderr
- `process/exited` for completion
- `process/kill` for cancellation

No natural-language task is sent to a Codex model.

Long jobs use `process/spawn`, which is not a Codex-sandbox API. Therefore **long jobs must run inside a real isolation boundary such as this project's Docker container or a VM**. Do not enable `CSB_LONG_JOBS=1` on an unisolated host unless you intentionally want ChatGPT actions to execute directly on that host.

## Recommended deployment: Docker + Secure MCP Tunnel

The included Compose file has two services:

```text
Internet / OpenAI
      │ outbound HTTPS
      ▼
tunnel-client
      │ private Docker network
      ▼
bridge
      │
      ├── /workspace
      └── /state
```

The bridge publishes **no host port** in the Compose deployment. The official OpenAI tunnel client initiates the outbound connection.

### 1. Prepare

```bash
git clone https://github.com/jiho-symply/chatgpt-sandbox-bridge.git
cd chatgpt-sandbox-bridge

mkdir -p workspace
cp .env.example .env
```

Set in `.env`:

```dotenv
CSB_BEARER_TOKEN=<long-random-secret>
CONTROL_PLANE_TUNNEL_ID=<your-tunnel-id>
CONTROL_PLANE_API_KEY=<your-tunnel-runtime-api-key>
```

Use the tunnel ID/runtime key created through OpenAI's Secure MCP Tunnel setup.

### 2. Start

```bash
docker compose up -d --build
```

Check:

```bash
docker compose ps
docker compose logs -f tunnel-client bridge
```

### 3. Connect from ChatGPT Web Chat

Create/connect the ChatGPT connector that points to the Secure MCP Tunnel, then use it in an ordinary Chat conversation.

The bridge advertises real read and action semantics. Whether a given ChatGPT account/workspace may invoke `run`, `start_job`, `cancel_job`, or `import_files` is enforced by ChatGPT's connector/action permission layer.

This project does **not** turn action tools into fake read tools to circumvent that layer.

## Local development

For local MCP testing without the tunnel:

```bash
npm install
npm run build

export CSB_WORKSPACE_ROOT="$PWD/workspace"
export CSB_STATE_DIR="$PWD/.state"
export CSB_BEARER_TOKEN='replace-with-a-long-random-secret'
npm start
```

Default endpoints:

```text
MCP:    http://127.0.0.1:8787/mcp
Health: http://127.0.0.1:8787/health
```

A bearer token is mandatory when binding beyond loopback.

## Configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `CSB_HOST` | `127.0.0.1` | Bridge bind host |
| `CSB_PORT` | `8787` | Bridge HTTP port |
| `CSB_WORKSPACE_ROOT` | current directory | Only exposed workspace |
| `CSB_STATE_DIR` | `~/.chatgpt-sandbox-bridge` | Durable job metadata/logs |
| `CSB_CODEX_BIN` | `codex` | Codex executable |
| `CSB_SANDBOX_MODE` | `workspaceWrite` | `workspaceWrite` or `externalSandbox` |
| `CSB_NETWORK` | `false` | Network flag passed with `externalSandbox` |
| `CSB_LONG_JOBS` | `false` | Enable unsandboxed-by-Codex `process/spawn`; use only inside hard isolation |
| `CSB_DEFAULT_RUN_TIMEOUT_MS` | `60000` | Default short-command timeout |
| `CSB_MAX_RUN_TIMEOUT_MS` | `120000` | Maximum short-command timeout |
| `CSB_MAX_JOB_TIMEOUT_MS` | `604800000` | Maximum explicit long-job timeout (7 days) |
| `CSB_MAX_JOBS` | `1000` | Durable job history cap |
| `CSB_MAX_READ_BYTES` | `1048576` | Maximum text/log bytes returned per call |
| `CSB_MAX_IMPORT_BYTES` | `104857600` | Maximum imported file size |
| `CSB_MAX_EXPORT_BYTES` | `52428800` | Maximum exported artifact size |
| `CSB_BEARER_TOKEN` | unset | Tunnel -> bridge authentication secret |

## Security model

The default Compose deployment deliberately treats Docker as the security boundary for long jobs.

- unprivileged container user
- no Docker socket
- only the chosen workspace and bridge state are mounted
- no host PID namespace
- all Linux capabilities dropped by Compose
- `no-new-privileges`
- bounded PID count
- relative-path confinement
- read/write path checks reject workspace escapes and symlink traversal
- execution receives argv arrays; no implicit shell
- action tools are correctly annotated as actions
- idempotent request IDs for long-job submission
- output reads are bounded and cursor-based
- bridge/tunnel/API credentials are removed from the environment inherited by Codex execution processes

If ChatGPT intentionally needs shell syntax, it must explicitly execute a shell:

```json
{
  "command": ["bash", "-lc", "python3 main.py && python3 analyze.py"]
}
```

The default Compose bridge has outbound networking because `import_files` must fetch ChatGPT temporary attachment URLs and many development workflows require package/network access. Add a separate network policy/worker boundary if arbitrary job internet access is not desired.

## Validation

```bash
npm run typecheck
npm test
docker build .
```

Tests cover:

- workspace traversal rejection
- symlink escape rejection
- long-job idempotency
- streamed log persistence
- active-job orphaning after bridge restart
- artifact resource round-trip and size limits

## Design inspiration

The transport and harness design deliberately borrows several proven ideas from [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web):

- OpenAI Secure MCP Tunnel instead of a public inbound listener
- bounded polling instead of holding one MCP call indefinitely
- explicit action annotations
- fail-closed tool/runtime behavior
- tool/resource transport rather than copying every binary into model context

The direction is reversed: `codex-chatgpt-web` lets Codex use ChatGPT Web and route ChatGPT tool calls back into Codex; this project starts from ChatGPT Web Chat and exposes only an isolated execution environment.

## Status

v0.2 is intentionally focused on:

1. short commands,
2. long-running jobs,
3. incremental logs,
4. cancellation,
5. durable job metadata,
6. file import/export,
7. Secure MCP Tunnel deployment.

Interactive PTY/stdin sessions and an external worker that can preserve active jobs across bridge restarts are future extensions.
