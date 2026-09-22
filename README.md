# ChatGPT Sandbox Bridge

Expose one isolated coding workspace to **ChatGPT Web Chat** through a minimal MCP action bridge.

The design deliberately keeps ChatGPT as the only reasoning/coding agent:

```text
ChatGPT Web Chat
      |
      | MCP/App action
      v
chatgpt-sandbox-bridge
      |
      | exact argv only
      v
codex app-server
      |
      | command/exec (no thread, no turn, no model reasoning)
      v
isolated workspace
```

Codex is used only as an execution harness. The bridge never sends natural-language coding tasks to a Codex model.

## Tools

| Tool | Type | Purpose |
| --- | --- | --- |
| `status` | read | Runtime, workspace, sandbox and recent-job status |
| `execute` | **write/action** | Start one exact argv command in the sandbox |
| `get_result` | read | Poll one exact execution job for stdout/stderr/exit code |
| `read_file` | read | Read bounded UTF-8 text inside the workspace |

`execute` is intentionally declared as a write/action tool. It is **not** mislabeled as read-only to bypass ChatGPT permission controls.

## Requirements

- Node.js 22+
- OpenAI Codex CLI with `codex app-server` and experimental `command/exec`
- A directory to expose as the workspace
- A remote/tunneled MCP endpoint that ChatGPT can reach

The bridge initializes `codex app-server` with `experimentalApi: true` and calls only `command/exec`. It does not create Codex threads or turns.

## Local run

```bash
npm install
npm run build

export CSB_WORKSPACE_ROOT=/absolute/path/to/workspace
export CSB_BEARER_TOKEN='replace-with-a-long-random-secret'
npm start
```

The MCP endpoint is:

```text
http://127.0.0.1:8787/mcp
```

Health check:

```text
http://127.0.0.1:8787/health
```

If the service binds to anything other than loopback, `CSB_BEARER_TOKEN` is required.

## Docker

Build:

```bash
docker build -t chatgpt-sandbox-bridge .
```

Run:

```bash
docker run --rm \
  -p 127.0.0.1:8787:8787 \
  -e CSB_BEARER_TOKEN='replace-with-a-long-random-secret' \
  -v "$PWD/workspace:/workspace" \
  chatgpt-sandbox-bridge
```

The container itself is an isolation boundary, while Codex `workspaceWrite` remains enabled inside it. Only `/workspace` is writable by the unprivileged runtime user; the bridge application directory remains root-owned.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CSB_HOST` | `127.0.0.1` | HTTP bind host |
| `CSB_PORT` | `8787` | HTTP port |
| `CSB_WORKSPACE_ROOT` | current directory | Only allowed workspace root |
| `CSB_CODEX_BIN` | `codex` | Codex executable |
| `CSB_SANDBOX_MODE` | `workspaceWrite` | `workspaceWrite` or `externalSandbox` |
| `CSB_NETWORK` | `false` | Network flag for `externalSandbox` |
| `CSB_DEFAULT_TIMEOUT_MS` | `120000` | Default command timeout |
| `CSB_MAX_TIMEOUT_MS` | `3600000` | Maximum command timeout |
| `CSB_MAX_JOBS` | `200` | In-memory job history |
| `CSB_MAX_READ_BYTES` | `1048576` | Maximum bytes per `read_file` |
| `CSB_BEARER_TOKEN` | unset | Optional on loopback; mandatory otherwise |

All `cwd` and file paths supplied through MCP are relative to `CSB_WORKSPACE_ROOT`. Absolute paths and path traversal outside the root are rejected.

## Execution protocol

A normal ChatGPT flow is:

```text
execute({
  command: ["python3", "main.py"],
  cwd: ".",
  request_id: "chat-20260922-001"
})
      |
      v
{ job_id, status: "running", ... }

get_result({ job_id, wait_ms: 20000 })
      |
      v
{ status, exit_code, stdout, stderr, ... }
```

`request_id` is idempotent. Reusing it with the same command returns the existing job; reusing it with different content is rejected.

For shell syntax, explicitly invoke a shell:

```json
{
  "command": ["bash", "-lc", "python3 main.py && pytest -q"]
}
```

The bridge never implicitly passes command text through a shell.

## ChatGPT Web Chat / Pro note

This repository implements the same **action + result-polling shape** that worked in the earlier Codex bridge, but it does not disguise execution as a read operation.

OpenAI currently documents private custom MCP write/modify actions as Full MCP functionality, while Pro custom MCP access is limited to read/fetch. Therefore:

- If the account still has an App/Plugin action route that exposes write tools in normal Chat, register this MCP endpoint through that route and `execute` can be invoked normally.
- If ChatGPT only offers Pro read/fetch custom MCP for this endpoint, `status`, `get_result`, and `read_file` can be exposed but `execute` will remain blocked by the product permission layer.
- The bridge intentionally does not relabel `execute` as read-only to evade that restriction.

This is the only ChatGPT-side integration constraint; the execution backend itself does not require a Codex agent conversation.

## Security model

- One configured workspace root.
- Relative-path confinement.
- Unprivileged container user.
- Exact argv execution; no implicit shell.
- Explicit action annotation for execution.
- Idempotent request IDs.
- Maximum execution timeout.
- Bounded file reads.
- Optional bearer authentication.
- No Docker socket mount.
- No host filesystem mount other than the chosen workspace.

For higher isolation, run the bridge inside a disposable VM/container and mount only a disposable workspace.

## Development

```bash
npm run typecheck
npm test
```

The first milestone is intentionally small: one execution primitive, polling, file reads, and status. Interactive PTY/stdin and persistent process sessions can be added later using Codex `command/exec/write`, `command/exec/resize`, and `command/exec/terminate`.
