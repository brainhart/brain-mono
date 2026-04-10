# Session-Based Workflow Orchestration — Design Notes

Companion to `14-session-workflow.ts`. This document maps the Go
`pi-workflow` actor model to Pi-native session primitives and argues for
why `AgentSessionRuntime` is the right foundation.

---

## The Go gist in 30 seconds

The gist implements a CLI tool (`pi-workflow`) that coordinates multiple
`pi` agent processes via a file-system actor model:

- **Actors** are directories (`actors/<id>/`) with an append-only inbox
  (`inbox.ndjson`), a mutable store (`store/`), and a signal file.
- **Messages** are JSON lines appended to inboxes.
- **Spawn** launches `pi` in a tmux pane, building the prompt from the
  actor's inbox + store.
- **Profiles** are markdown files with frontmatter that configure model,
  tools, and system prompt per role (worker, reviewer, etc.).
- **Wait/poll** watches file sizes to detect new messages.
- **The controller** is itself a `pi` actor that sends assignments,
  reads results, and advances checkpoints.

It works. But every one of these mechanisms has a Pi-native counterpart
that's already maintained, tested, and integrated with the agent loop.

---

## Concept mapping

| Go workflow CLI | Pi session primitive | Notes |
|---|---|---|
| `workflow dir` | `SessionManager` | Manages session files on disk under `.pi/sessions/` |
| `actor` | `AgentSession` | One session = one actor's turn. Isolated entry log. |
| `inbox.ndjson` | `session.getEntries()` / `appendEntry()` | Ordered log of typed entries. Same semantics, no file format to manage. |
| `store/` directory | Custom session entries (`type: "custom"`) | Structured data stored inline in the session log. For large artifacts, use file refs. |
| `message` (send) | `appendEntry({ type: "custom", customType: "workflow-message", data })` | Same payload flexibility. Type-safe with TypeScript. |
| `signal` file | `runtime.switchSession()` | The runtime activates a session; no file-system signal needed. |
| `spawn` (tmux) | `runtime.newSession()` | Creates a fresh session and makes it active. No tmux. |
| `controller` actor | Orchestrator code (TypeScript) | The controller doesn't need to be an LLM. Plain code is better for flow control. |
| `worker` / `reviewer` | `AgentSession` with role-specific extensions | Extensions inject system prompt, restrict tools, define behavior. |
| `profile` (.md frontmatter) | `CreateAgentSessionRuntimeFactory` closure | The factory captures model, tools, instructions per role. Or use the preset extension. |
| `refs` / attachments | File paths in custom entries | Same idea — reference files for the session to read. |
| `handoff` (store file) | `appendEntry({ customType: "handoff", data })` | Structured handoff data lives in the session log. Existing handoff extension already does this. |
| `wait` / `wait-any` | `session.subscribe()` | Event-driven, in-process. No polling. |
| `check` / `kill` | `runtime.session` / `runtime.dispose()` | Direct access to the active session. |
| `buildSpawnPrompt()` | `before_agent_start` extension hook | Hook reads entries and builds the system prompt dynamically. |
| `collectAttachments()` | Extension reads entry refs, attaches files | Same pattern, no shell-out. |
| `auto-notify on exit` | `session_shutdown` hook + `appendEntry()` | The auto-commit-on-exit extension already demonstrates this exact pattern. |

---

## Why sessions are the right primitive

### 1. The inbox IS the session log

The Go gist's core data structure is an append-only ndjson file per
actor. Pi sessions are already append-only entry logs. Every entry has a
type, optional payload, and ordering guarantees. Using sessions means:

- No file-format code to write or maintain
- Entries are typed and validated
- The session UI (branching, replay, resume) works automatically
- Existing extensions (summarize, handoff) compose with workflow entries

### 2. No tmux management

The gist's `spawn.go` and `terminal.go` are ~300 lines of tmux socket
management, wrapper scripts, and pane lifecycle. With the session
runtime:

- `newSession()` replaces `Spawn()`
- `switchSession()` replaces switching between tmux panes
- `dispose()` replaces `Kill()`
- No socket files, no wrapper scripts, no process management

### 3. The controller should be code, not an LLM

The gist's most interesting insight is that the controller is
orchestration logic — it doesn't need to "think", it follows a protocol.
Making the controller regular TypeScript (not an LLM session) is
strictly better:

- Deterministic flow control (if/else, loops, try/catch)
- No prompt engineering for "now send an assignment to a reviewer"
- Type-safe message schemas
- Testable without LLM calls
- Faster and cheaper (no tokens for orchestration)

The LLM sessions are only for the workers and reviewers — the actors
that actually need to reason about code.

### 4. Event subscriptions replace polling

The Go `wait.go` polls file sizes every 250ms. Pi sessions have
`subscribe()` which delivers typed events in-process. This is:

- More responsive (no polling interval)
- More efficient (no filesystem stat loops)
- Type-safe (events have discriminated union types)
- Composable (multiple subscribers, filtering, etc.)

### 5. Extensions compose where profiles don't

The gist's profile system (markdown frontmatter → model + tools + system
prompt) is a good idea. But Pi extensions are strictly more powerful:

- **Lifecycle hooks**: `session_start`, `turn_start`,
  `before_agent_start`, `session_shutdown` — fine-grained control over
  when behavior runs.
- **Tool registration**: Extensions can register custom tools, not just
  restrict the built-in set.
- **Commands**: `/handoff`, `/preset`, `/summarize` — interactive
  commands that profiles can't express.
- **Composition**: Multiple extensions stack. A worker can have
  `auto-commit-on-exit` + `handoff` + a workflow-specific extension.

The preset extension already provides the profile-like UX (named configs
with model/tools/instructions), and it's composable with everything
else.

---

## Pattern: Workflow as session orchestrator

```
┌─────────────────────────────────────────────────┐
│  Orchestrator (TypeScript, not an LLM)          │
│                                                 │
│  const runtime = createAgentSessionRuntime(...) │
│                                                 │
│  1. runtime.newSession()  → worker session      │
│     appendEntry(assignment)                     │
│     bindExtensions({ role: "worker" })          │
│     await session result                        │
│                                                 │
│  2. runtime.newSession()  → reviewer session    │
│     appendEntry(assignment + handoff from 1)    │
│     bindExtensions({ role: "reviewer" })        │
│     await session result                        │
│                                                 │
│  3. runtime.switchSession(controller)           │
│     appendEntry(advancement)                    │
│                                                 │
│  4. runtime.dispose()                           │
└─────────────────────────────────────────────────┘
```

Each worker/reviewer session:
- Receives its context as entries (the "inbox")
- Runs with role-specific extensions (the "profile")
- Produces a result entry when done (the "response message")
- Can save structured handoff data as entries (the "store")

The orchestrator:
- Creates and switches sessions (no tmux)
- Reads result entries (no polling)
- Carries handoff context forward (no file copying)
- Is deterministic TypeScript (no LLM for flow control)

---

## What's left to build

The `14-session-workflow.ts` example shows the wiring but uses simulated
messages. To make it fully functional:

1. **Steering integration** — after creating a worker session and
   injecting entries, submit a steering prompt so the LLM actually runs.
   This requires hooking `before_agent_start` to build the prompt from
   workflow-message entries.

2. **Result detection** — define a convention for how a worker session
   signals completion. Options:
   - A `session_shutdown` hook that appends a "result" entry
   - A custom tool (`report_result`) that the worker calls explicitly
   - The orchestrator reads the last assistant message as the result

3. **Parallel fan-out** — the gist supports parallel reviewers. With the
   session runtime (which manages one active session at a time), true
   parallelism requires either:
   - Multiple runtime instances (one per parallel actor)
   - Sequential fan-out with fast switching
   - A process-level parallel runner (but then we're back to tmux)

   For most workflows, sequential is fine — the LLM turns are the
   bottleneck, not the switching.

4. **Workflow-aware extension** — package the orchestration pattern as a
   Pi extension that:
   - Registers `/workflow` commands
   - Manages the session graph
   - Provides the `before_agent_start` hook that builds prompts from
     entries
   - Handles result detection and handoff automatically

5. **Persistence** — the session files ARE the persistence. A workflow
   can be resumed by listing session files and reconstructing the graph
   from their entries. No separate `workflow.json` needed.
