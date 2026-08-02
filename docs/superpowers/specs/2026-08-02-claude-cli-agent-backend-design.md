---
name: claude-cli-agent-backend
description: Make the Claude CLI (Claude Code) a pluggable agent backend in Fabro workflows, alongside the native agentic loop.
status: backlog
created: 2026-08-02T07:38:48Z
updated: 2026-08-02T07:38:48Z
---

# Claude CLI as a pluggable agent backend

## Motivation

Fabro currently runs its own native Rust agentic loop (`fabro-agent`): `Session` drives
the loop, `AgentProfile` (Anthropic/OpenAI/Gemini) supplies model + tools + system
prompt, executing against a `Sandbox` (local/Docker/Daytona). This design adds the
`claude` CLI (Claude Code, headless) as an **alternative agent backend** without
replacing the native loop.

Goals (confirmed with the user):

1. **Better agent quality** — leverage Claude Code's mature tool ecosystem, skills,
   compaction, and subagents rather than re-implementing them in the native loop.
2. **Subscription auth** — run agents on a Claude Pro/Max subscription (OAuth) via the
   CLI instead of only metered API keys.
3. **Pluggable agent backends** — establish a general external-agent-CLI abstraction so
   Fabro can orchestrate any agent binary (claude now; codex / gemini-cli / aider
   later), not just its native loop.

Non-goals: this is **not** about retiring the native loop. Native stays the default and
its behavior must not change.

## Success criteria (MVP)

A workflow agent node can select the `claude-code` backend and, running headless in a
sandbox with subscription auth:

- edit files in `/workspace`,
- stream progress into Fabro's event log and surface in the web UI like a native run,
- produce a run outcome (final text + token/cost usage) and a git diff / PR from the
  workspace.

```
fabro run implement-issue --engine claude-code
  → claude runs in Docker /workspace
  → events + result surface in Fabro UI
  → git diff / PR from workspace
```

HITL, steering, and Fabro-managed CLI config are **out of scope for MVP** (see §8).

## Architecture & boundary

A new trait `AgentBackend` is introduced at the agent-stage boundary in
`fabro-workflow`. The agent-stage handler (`lib/crates/fabro-workflow/src/handler/llm/api.rs`)
stops calling `build_profile` + `Session::new` directly and instead resolves an
`AgentBackend`, then calls `backend.run(...)`.

```
agent-stage handler
   └─ resolve_backend(node, config) -> Box<dyn AgentBackend>
        ├─ NativeBackend      (wraps today's build_profile + Session)  ← default, unchanged behavior
        └─ ClaudeCodeBackend  (spawns `claude` via Sandbox::spawn_stdio_process)
```

The trait, approximately:

```rust
#[async_trait]
pub trait AgentBackend: Send + Sync {
    async fn run(
        &self,
        req: AgentRunRequest,
        sandbox: Arc<dyn Sandbox>,
        emitter: Arc<Emitter>,
        ctx: AgentRunContext,
    ) -> Result<AgentOutcome>;
}
```

- `AgentRunRequest` — task prompt, model, workspace path, and a steering handle
  (reserved; unused in MVP).
- `AgentRunContext` — run/session ids, cancellation token, config needed to build events.
- `AgentOutcome` — final text/result, token/cost usage (`TokenCounts`), and a
  file-change summary.

Why a trait at this boundary (rather than a new `AgentProfileKind` or a new workflow
stage type): the CLI owns its own loop, tools, and system prompt, so it does not fit
`AgentProfile`, which is tightly coupled to the native `Session`. A backend trait keeps
the alien execution model isolated and generalizes to future CLIs. `NativeBackend` is a
straight extraction of current code with **no behavior change**, which de-risks the
refactor.

## `ClaudeCodeBackend` — process model

Runs the CLI through the sandbox so "host vs. container" is handled by the existing
provider abstraction (LocalSandbox = host-scoped-to-workspace; DockerSandbox/Daytona =
container). No new host/container branching in the backend itself.

Invocation (headless, streaming):

```
claude -p "<task>" \
  --output-format stream-json --verbose \
  --input-format stream-json \
  --permission-mode acceptEdits \
  --model <mapped model>
```

- Launched via `Sandbox::spawn_stdio_process(...)` with cwd = workspace. This method
  exists on all providers (`local.rs`, `docker.rs`, `worktree.rs`) with bidirectional
  stdio.
- `--input-format stream-json` stdin is wired but **unused in MVP** (reserved for
  steering — see §8).
- The backend reads stdout as line-delimited JSON to completion, captures the terminal
  `result` event, then returns `AgentOutcome`.
- **Preflight:** a `claude --version` (or `which claude`) check in the sandbox yields a
  clear "backend unavailable" error instead of a cryptic spawn failure. `fabro doctor`
  runs the same check (see §6).
- **Cancellation:** the run's cancellation token kills the spawned process and drains
  stdout; a partial `AgentOutcome` (whatever was captured) is returned with a cancelled
  status, consistent with native cancellation.

## Event, UI visibility & result mapping

Claude Code `stream-json` events are translated to Fabro's existing `AgentEvent`
variants, wrapped by the workflow into `Event::Agent { … }` (as native does at
`handler/llm/api.rs:565`) and pushed through the **same shared `Emitter`**. That
`Emitter` feeds the run event store → server SSE (`/events`) → web UI. Because
`ClaudeCodeBackend` emits into the same `Emitter`, the UI cannot tell a CLI run apart
from a native run.

Mapping:

| Claude Code stream-json | Fabro `AgentEvent` | UI shows |
|---|---|---|
| `assistant` text | `AssistantMessage` / `TextDelta` | message bubbles |
| `assistant` `tool_use` | `ToolCallStarted` | tool-call card (name + args) |
| `user` `tool_result` | `ToolCallCompleted` | tool result / status |
| `result` (final) | outcome + `TokenCounts` | final answer, token/cost usage |
| session begin / end | `Event::AgentSessionStarted` / `AgentSessionEnded` | run timeline entry |

- Unknown event types are logged at `debug` and skipped (forward-compat with CLI
  updates).
- File changes are captured from the workspace via the existing git-diff / artifact
  snapshot machinery used by native runs — no reliance on CLI-specific change reporting.

### Fidelity gaps (documented, expected)

These are native-loop internals that Claude Code runs itself, so they will **not**
populate for CLI runs. This is acceptable for MVP but must be documented so the UI's
empty affordances aren't read as bugs:

- **Compaction UI** (`CompactionStarted` / `CompactionCompleted`) and **context-window
  projection** — Claude Code does its own compaction and won't emit Fabro's events, so
  these stay blank.
- **Tool palette** (`AgentToolsAvailable`) — native derives it from its `ToolRegistry`;
  CLI tools are Claude's own, so this is best-effort or absent.
- **Thinking / reasoning stream** (`ReasoningDelta`) — only shown if the CLI streams
  thinking blocks in `-p` mode; otherwise absent.

## Auth & env injection

Two mechanisms, both applied when spawning; secrets flow through Fabro's existing
env-scrubbing path so tokens are not leaked into logs/telemetry
(`docs/internal/server-secrets-strategy.md`).

1. **OAuth token env** — Fabro injects `CLAUDE_CODE_OAUTH_TOKEN` from the same Claude
   subscription OAuth it already resolves for the native anthropic provider (commit
   `db51f25ea`). Works in both host and container.
2. **Mount host `~/.claude`** — opt-in (config-gated). For container runs, mount/copy the
   operator's `~/.claude` (credentials + settings) into the sandbox; for host/local runs
   the CLI already sees it. Gated because it couples runs to host login state.

Precedence: explicit `CLAUDE_CODE_OAUTH_TOKEN` env > mounted host creds. (API-key auth
via `ANTHROPIC_API_KEY` is not a primary path for MVP but is not actively blocked if the
env is present.)

## Selection & config surface

- **Workflow node:** `engine="claude-code"` attribute on an agent node (default
  `native`), matching the `--engine claude-code` invocation.
- **Model mapping:** the node's `model` maps to `--model`; a small alias table handles
  Fabro model ids → Claude Code model names.
- **Global / run config:** an `[agent.backends.claude_code]` block for:
  - `binary_path` (default: `claude` on PATH),
  - `mount_host_claude_dir` (bool, default false),
  - `permission_mode` (default `acceptEdits`).
- **`fabro doctor`:** a new check that the `claude` binary and auth resolve, matching the
  existing provider-readiness pattern.

## Testing

- **Unit:** stream-json → `AgentEvent` mapping (fixtures of recorded CLI output);
  backend selection / config parsing; env-injection precedence; unknown-event skip.
- **Integration (twin):** a fake `claude` script that emits canned stream-json, driven
  through a real `LocalSandbox`, asserting emitted events + `AgentOutcome` + captured
  file changes. Uses `.no_proxy()` HTTP clients per repo testing rules where applicable.
- **E2E (`live`, gated):** `fabro run implement-issue --engine claude-code` against a
  real subscription in Docker, asserting a diff / PR is produced. Marked
  `#[e2e_test(live(...))]`.

## Out of scope for MVP

Enabled by the trait but deferred ("start thin, grow managed"):

- HITL / permission-prompt bridging (Claude's `can-use-tool` prompts → Fabro HITL).
- Mid-run steering (feeding `--input-format stream-json` from Fabro's steering hub).
- Fabro-managed CLI config: generated `.claude/settings.json`, `--allowedTools`,
  `--mcp-config`, `--append-system-prompt` for workflow policy enforcement.
- A second backend (codex / gemini-cli) to prove pluggability.

## Open questions

- Exact Fabro-model-id → Claude-Code-model-name alias table (resolve during
  implementation against the current model catalog).
- Whether to surface a best-effort `AgentToolsAvailable` for CLI runs or leave it empty
  in MVP (leaning empty).
