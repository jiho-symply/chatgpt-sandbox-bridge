# ChatGPT Sandbox Bridge

Expose **an execution environment you prepared** to ChatGPT Web Chat.

This project does not create a Docker container, VM, WSL distribution, CUDA stack, Python environment, solver environment, or filesystem layout. Run the bridge inside whatever environment you want ChatGPT to use.

Examples include your own WSL2 distribution, Docker/Podman container, NVIDIA CUDA/PyTorch container, VM, remote Linux server, Conda environment, Gurobi/CPLEX environment, or Slurm compute node.

~~~text
ChatGPT Web Chat
        |
        v
OpenAI Secure MCP Tunnel
        |
        v
chatgpt-sandbox-bridge --stdio
        |
        v
Codex app-server
(execution harness only)
        |
        +-- command/exec   short commands
        +-- process/spawn  long jobs
                |
                v
      YOUR execution environment
~~~

ChatGPT is the only reasoning/coding agent. The bridge never sends a natural-language task to a Codex model and does not create Codex threads or turns.

## Responsibilities

### You provide

- operating system and isolation boundary
- CPU / GPU
- NVIDIA driver / CUDA
- Python / Conda
- PyTorch / TensorFlow
- Gurobi / CPLEX / OR-Tools
- compilers and project files
- network policy
- workload licenses and credentials

### This repository provides

- short command execution
- long-running jobs
- incremental stdout/stderr
- cancellation
- durable job metadata
- file import/export
- MCP transport
- Codex app-server adapter

## MCP tools

| Tool | Type | Purpose |
| --- | --- | --- |
| status | read | Runtime, workspace and recent jobs |
| run | action | Run a short exact argv command |
| start_job | action | Start a long-running process |
| get_job | read | Get job state / bounded wait |
| read_job_output | read | Incremental stdout/stderr |
| list_jobs | read | Recover recent job IDs |
| cancel_job | action | Terminate a long job |
| read_file | read | Read bounded UTF-8 workspace text |
| import_files | action | Copy ChatGPT attachments into the workspace |
| export_file | read | Return a workspace artifact as an MCP resource |

Action tools are declared as real actions, not as read-only operations.

## Install inside your environment

Requirements:

- Node.js 22+
- Codex CLI with app-server process APIs; CI currently tests @openai/codex 0.155.1
- the execution environment you want ChatGPT to operate

~~~bash
git clone https://github.com/jiho-symply/chatgpt-sandbox-bridge.git
cd chatgpt-sandbox-bridge

npm install
npm run build
npm link
~~~

Install the tested Codex version if needed:

~~~bash
npm install -g @openai/codex@0.155.1
~~~

Then:

~~~bash
chatgpt-sandbox-bridge --version
~~~

should print 0.3.0.

## Configure the environment

Choose the directory ChatGPT should normally work from:

~~~bash
export CSB_WORKSPACE_ROOT=/path/to/your/project-or-workspace
export CSB_STATE_DIR=$HOME/.chatgpt-sandbox-bridge
~~~

If the current environment itself is the isolation boundary you prepared:

~~~bash
export CSB_SANDBOX_MODE=externalSandbox
export CSB_NETWORK=true
export CSB_LONG_JOBS=true
~~~

Check the environment:

~~~bash
chatgpt-sandbox-bridge --doctor
~~~

Doctor reports workspace/state access, Codex, Node, Python, Git, NVIDIA visibility through nvidia-smi when present, execution policy, and long-job availability.

## Security boundary

CSB_WORKSPACE_ROOT constrains bridge file helpers and accepted working directories. It is **not an OS security boundary for arbitrary commands**.

With externalSandbox, commands can generally access anything available to the OS user running the bridge. Long jobs use Codex process/spawn, which is also outside the Codex sandbox.

Therefore, run the bridge inside the environment you are willing to let ChatGPT operate.

For example, if you need GPU isolation, create your own GPU-enabled container and install/run the bridge inside that container:

~~~text
your-gpu-container
+-- CUDA
+-- PyTorch
+-- Gurobi
+-- your project
+-- Codex CLI
+-- chatgpt-sandbox-bridge
~~~

This repository deliberately does not prescribe how that container is created.

The default short-command policy is workspaceWrite, which uses the Codex command sandbox. Long jobs are disabled by default. Enable externalSandbox and CSB_LONG_JOBS only when the surrounding environment is intentionally your execution boundary.

## Recommended transport: stdio + Secure MCP Tunnel

The bridge still supports HTTP, but the recommended local/private setup is stdio.

OpenAI tunnel-client can launch the local MCP server itself:

~~~text
tunnel-client
      | stdio
      v
chatgpt-sandbox-bridge --stdio
      |
      v
your environment
~~~

After installing the official tunnel-client:

~~~bash
export CONTROL_PLANE_TUNNEL_ID='tunnel_0123456789abcdef0123456789abcdef'
export CONTROL_PLANE_API_KEY='...'
export MCP_COMMAND='chatgpt-sandbox-bridge --stdio'

tunnel-client doctor --explain
tunnel-client run --log.level=info --log.format=struct-text
~~~

The tunnel uses an outbound connection, so the bridge needs no public inbound listener.

Official tunnel-client documentation:

- https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md
- https://github.com/openai/tunnel-client/blob/master/docs/connectors.md

The minimum runtime configuration is a tunnel ID, a runtime API key, and one main MCP binding. For this project the main binding is MCP_COMMAND=chatgpt-sandbox-bridge --stdio.

## WSL example

If you intentionally want the WSL distribution itself to be the execution environment:

~~~bash
cd ~/chatgpt-sandbox-bridge
git pull

npm install
npm run build
npm link
npm install -g @openai/codex@0.155.1

export CSB_WORKSPACE_ROOT="$HOME"
export CSB_STATE_DIR="$HOME/.chatgpt-sandbox-bridge"
export CSB_SANDBOX_MODE=externalSandbox
export CSB_NETWORK=true
export CSB_LONG_JOBS=true

chatgpt-sandbox-bridge --doctor
~~~

This exposes what that WSL user can access. It does not create another container.

If you want a custom GPU container instead, enter that container first and perform the same bridge installation there.

## Long-running ML / optimization jobs

For training, Gurobi/CPLEX solving, simulations, builds, or uncertain-duration processes, ChatGPT uses start_job and receives a durable job_id immediately.

ChatGPT can wait for changes only in short bounded calls:

~~~json
{
  "job_id": "...",
  "after_revision": 1,
  "wait_ms": 10000
}
~~~

Each wait is capped at 10 seconds. A later Chat turn can use list_jobs, get_job, and read_job_output to continue observing the same job.

Log reads use byte offsets, so solver/training logs do not need to be resent from the beginning.

### Restart semantics

Job metadata and logs persist under CSB_STATE_DIR.

Codex process/spawn handles are connection-scoped. If the bridge/app-server restarts while a process is running, the stored job is marked orphaned instead of falsely reported as owned/running.

If live jobs must survive bridge restarts, use an external scheduler or supervisor such as systemd, Slurm, Kubernetes Jobs, or another worker already present in your environment.

## File transfer

ChatGPT attachments can be copied into the workspace through import_files. Outbound HTTPS is required to fetch the temporary file URL.

Existing workspace files can be returned through export_file as MCP resource links. Typical outputs include CSV/XLSX, PDF, PNG/JPEG, Gurobi SOL/LP/MPS, ZIP/TAR, and model artifacts within the configured size limit.

## HTTP mode

HTTP remains available for development or deployments where another component manages the remote connection:

~~~bash
export CSB_WORKSPACE_ROOT=/path/to/workspace
chatgpt-sandbox-bridge --http
~~~

Default endpoint: http://127.0.0.1:8787/mcp

If HTTP binds beyond loopback, CSB_BEARER_TOKEN is required.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| CSB_WORKSPACE_ROOT | current directory | Workspace exposed through bridge helpers |
| CSB_STATE_DIR | ~/.chatgpt-sandbox-bridge | Durable metadata/logs |
| CSB_CODEX_BIN | codex | Codex executable |
| CSB_SANDBOX_MODE | workspaceWrite | workspaceWrite or externalSandbox |
| CSB_NETWORK | false for workspaceWrite, true for externalSandbox | Declared network availability |
| CSB_LONG_JOBS | false | Enable process/spawn long jobs |
| CSB_DEFAULT_RUN_TIMEOUT_MS | 60000 | Short-command default timeout |
| CSB_MAX_RUN_TIMEOUT_MS | 120000 | Short-command maximum timeout |
| CSB_MAX_JOB_TIMEOUT_MS | 604800000 | Maximum explicit long-job timeout |
| CSB_MAX_JOBS | 1000 | Durable job history cap |
| CSB_MAX_READ_BYTES | 1048576 | Maximum text/log bytes per read |
| CSB_MAX_IMPORT_BYTES | 104857600 | Maximum imported file size |
| CSB_MAX_EXPORT_BYTES | 52428800 | Maximum exported artifact size |
| CSB_HOST | 127.0.0.1 | HTTP-only bind address |
| CSB_PORT | 8787 | HTTP-only port |
| CSB_BEARER_TOKEN | unset | Required only for non-loopback HTTP |

## Validation

CI validates:

- TypeScript typecheck
- unit tests
- real Codex command/exec
- real Codex process/spawn and output streaming
- stdio MCP startup and tool discovery
- stdio MCP -> run -> Codex command/exec end-to-end
- doctor

The transport/harness design borrows ideas from miuuyy/codex-chatgpt-web, particularly Secure MCP Tunnel, bounded polling, explicit action annotations, fail-closed behavior, and resource-based file transport. The direction is reversed: this project starts in ChatGPT Web Chat and exposes a user-provided execution environment.
