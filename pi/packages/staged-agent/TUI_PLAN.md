# Staged-Agent TUI Design

## Vision

Bring the interactive, real-time experience of the pi CLI to staged-agent
job execution. The TUI provides the same per-task UX that pi gives for a
single session, plus a hierarchy layer that lets users observe and
interact with the entire job → stage → task tree.

## Navigation Model

The TUI uses a **drill-down stack** — the same pattern pi-tui extensions
use with `Container` / `SelectList`, but across the orchestration
hierarchy:

```
┌─────────────────────────────────────────────────────┐
│  Job Dashboard                                      │
│  ├─ [✓] plan        2/2 tasks  12.3s               │
│  ├─ [⟳] implement   1/3 tasks  running…            │  ← highlight
│  ├─ [◌] review      waiting                        │
│  └─ [◌] finalize    waiting                        │
│                                                     │
│  ↑↓ navigate  enter drill-down  p pause  c cancel  │
│  q quit                                             │
└─────────────────────────────────────────────────────┘
          │ enter
          ▼
┌─────────────────────────────────────────────────────┐
│  Stage: implement  (attempt 1)                      │
│  ├─ [✓] task-auth      success   4.2s              │
│  ├─ [⟳] task-api       running   6.1s…             │  ← highlight
│  └─ [✗] task-db        failed    2.0s  (retry 2/3) │
│                                                     │
│  esc back  enter drill-down  r retry-stage          │
└─────────────────────────────────────────────────────┘
          │ enter
          ▼
┌─────────────────────────────────────────────────────┐
│  Task: task-api  (attempt 1)                        │
│  ─────────────────────────────────                  │
│  Prompt: Implement the REST API for user management │
│                                                     │
│  Status: running  ⟳  elapsed 6.1s                  │
│  Session: pi-session-3                              │
│                                                     │
│  Result: (pending)                                  │
│                                                     │
│  esc back                                           │
└─────────────────────────────────────────────────────┘
```

## Key UX Principles

1. **Same feel as pi CLI** — each task view mirrors what you'd see in a
   single pi session: prompt, status, streaming result, session identity.

2. **Hierarchy is the new concept** — the dashboard and stage views are
   the added layers that let you see how tasks compose into stages and
   stages compose into the job DAG.

3. **Real-time updates** — events flow from the actor system through the
   event log into the TUI. Views update on every event.

4. **Non-blocking interaction** — pause/resume/cancel are messages to
   the existing actor system. The TUI never blocks the job.

5. **Keyboard-driven** — no mouse. Arrow keys, enter, escape, single
   letter shortcuts. Same interaction vocabulary as pi-tui's `SelectList`
   and `matchesKey`.

## Architecture

Built **on top of `@mariozechner/pi-tui`** — the same TUI framework
that powers the pi CLI. This means we get differential rendering,
Kitty keyboard protocol, proper Unicode/CJK width handling, overlay
support, and focus management for free.

```
  JobRunner  ──events──▶  EventLog  ──subscribe──▶  TuiApp
                                                       │
                                              ┌────────┴────────┐
                                              │ pi-tui TUI      │
                                              │ (diff render,   │
                                              │  focus, overlay) │
                                              ├─────────────────┤
                                              │ DashboardView   │  ← pi-tui Component
                                              │ StageView       │  ← pi-tui Component
                                              │ TaskView        │  ← pi-tui Component
                                              │ HelpView        │  ← pi-tui Component
                                              └─────────────────┘
                                                       │
                                              ┌────────┴────────┐
                                              │ ProcessTerminal │  ← from pi-tui
                                              │ (raw mode,      │
                                              │  Kitty protocol, │
                                              │  resize)         │
                                              └─────────────────┘
```

### What pi-tui provides (not rebuilt)

| Capability | pi-tui module |
|-----------|---------------|
| Terminal management | `ProcessTerminal` — raw mode, Kitty protocol, drain |
| Differential rendering | `TUI` — only redraws changed lines |
| Input parsing | `matchesKey`, `parseKey`, `Key` — all keyboard protocols |
| Unicode width | `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi` |
| Component model | `Component` interface with `render()` + `handleInput()` |
| Focus management | `TUI.setFocus()` — routes input to focused component |
| Overlay system | `TUI.showOverlay()` — for modal help, etc. |
| Text components | `Text`, `SelectList`, `Box`, `Markdown`, `Loader` |

### What staged-agent adds

| Module | Responsibility |
|--------|---------------|
| `tui/helpers.ts` | Thin wrappers: status icons/labels, duration formatting |
| `tui/views/dashboard.ts` | Job-level DAG overview (pi-tui `Component`) |
| `tui/views/stage.ts` | Stage detail with task list (pi-tui `Component`) |
| `tui/views/task.ts` | Task detail with prompt/result (pi-tui `Component`) |
| `tui/views/help.ts` | Keybinding reference (pi-tui `Component`) |
| `tui/app.ts` | Wires `TUI` + `ProcessTerminal` + view stack + `JobRunner` |

### Integration Points

**EventLog subscription** — `EventLog.subscribe(cb)` notifies the TUI
on every `append()`. The TUI calls `projectState()` to rebuild the view
model from events.

**JobRunner control** — `runner.cancel()`, `runner.resume()` are already
public. The TUI calls them in response to keypresses.

**State projection** — `projectState(events)` already exists and produces
`JobState` with stages, tasks, results. The TUI uses this as its single
view model.

## Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `↑` / `k` | any list | move cursor up |
| `↓` / `j` | any list | move cursor down |
| `enter` | dashboard | drill into selected stage |
| `enter` | stage view | drill into selected task |
| `esc` / `backspace` | stage/task view | go back to parent |
| `p` | dashboard | pause job |
| `r` | dashboard | resume job |
| `c` | dashboard | cancel job |
| `?` | any | toggle help overlay |
| `q` | any | quit TUI (job continues) |

## Event Flow

1. `TaskActor` / `StageActor` / `DAGSchedulerActor` call `log.append(event)`
2. `EventLog.append()` persists the event and calls `subscriber(event)`
3. `TuiApp.onEvent()` calls `projectState()` to rebuild `JobState`
4. `TuiApp` tells the active view to re-render
5. `Screen` writes ANSI output to stdout

## View Details

### Dashboard View

Shows job status, a list of all stages with status icons, task counts,
elapsed time, and DAG dependency arrows. Highlights the selected stage.
Footer shows available keybindings.

Header: `Job <id> [running]` with elapsed time.

Stage list items:
```
[⟳] implement  1/3 tasks  running…  6.1s  (attempt 1)
```

### Stage View

Shows stage metadata (name, attempt count, completion policy) and a
list of tasks within the stage. Each task shows status, elapsed time,
retry count.

### Task View

The per-task view most closely matches the pi CLI experience:
- Task prompt (the "user message" equivalent)
- Status with live elapsed timer
- Session ID
- Result summary when complete (the "assistant response" equivalent)
- Error details on failure

### Help Overlay

Full keybinding reference. Toggled with `?`. Rendered on top of the
current view.

## Future Directions

- **Streaming task output** — pipe pi subprocess stdout into the task
  view for live token streaming (same as pi CLI's main loop).
- **Log tailing** — tail the NDJSON event log in a split pane.
- **DAG visualization** — ASCII art of the stage DAG with
  topological layout.
- **Task input** — send follow-up prompts to paused/blocked tasks
  (mirrors pi's interactive prompt).
- **Session handoff** — `/handoff` from a task view into a fresh pi
  CLI session, carrying context (mirrors the handoff extension).
