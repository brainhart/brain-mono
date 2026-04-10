# Stage-Based Agent Runtime Plan

## Summary

Build a workflow runtime on top of Pi's native session runtime.

- **Pi runtime** remains the session execution primitive.
- **Workflow runtime** becomes the orchestration layer.
- **Workflow state** is log-oriented on disk, with in-memory state treated as a projection/cache.

The core model is:

- **workflow** = entire run
- **stage** = coordinated batch of work with a completion policy
- **task** = smallest schedulable unit of work
- **task attempt** = one Pi session execution
- **barrier** = synchronization point that decides what happens next

## Goals

- Stay Pi-native by treating sessions as the execution unit
- Support sequential and parallel stage execution
- Support barrier-driven dynamic stage creation
- Support loops such as "repeat until approved"
- Make decisions from structured task outputs, not transcript scraping
- Support restart/recovery from durable on-disk state

## Non-goals for v0

- Full distributed scheduling
- A second transcript store parallel to Pi sessions
- A large declarative DAG engine on day one

## Architecture

### 1. SessionHost

Wraps Pi's `AgentSessionRuntime` pattern.

Responsibilities:

- create, switch, resume, and dispose sessions
- rebind session-local listeners after session replacement
- expose session handles to higher-level orchestration code

### 2. TaskExecutor

Executes a single task attempt in one Pi session.

Responsibilities:

- prepare task prompt and context
- create or resume the session for that attempt
- run the task to completion
- collect a structured result

### 3. StageScheduler

Coordinates tasks within a stage.

Responsibilities:

- determine runnable tasks
- dispatch tasks, including parallel work
- monitor completion policy
- move a stage into barrier evaluation

### 4. BarrierProcessor

Evaluates stage outputs and decides what to materialize next.

Responsibilities:

- aggregate task results
- apply completion/decision logic
- schedule downstream stages, retries, or pauses

### 5. WorkflowRuntime

Top-level orchestrator.

Responsibilities:

- create and resume workflow runs
- coordinate schedulers, executors, and barriers
- manage workflow lifecycle

## Execution Model

1. Create workflow run
2. Materialize initial stage(s)
3. Schedule task(s) in each runnable stage
4. Execute each task attempt in its own Pi session
5. Capture structured task results
6. Evaluate stage completion policy
7. Enter barrier
8. Aggregate outputs and decide next action
9. Materialize downstream stage(s)
10. Repeat until the workflow completes, pauses, or fails

## Stage Model

Stages are scheduler boundaries and barrier boundaries.

Examples:

- planning
- implementation
- review
- remediation
- adjudication
- human approval

Initial completion policies:

- `all`
- `quorum(n)`
- `first_success`
- `predicate(fn)`

## Task Model

Each task attempt should usually run in a fresh Pi session.

Benefits:

- role isolation
- clean lineage
- easier retries
- independent reviews
- simpler recovery

Each task should emit a structured result such as:

```ts
type TaskResult = {
  status: "success" | "failure" | "blocked";
  summary: string;
  artifacts?: string[];
  signals?: Record<string, unknown>;
  metrics?: Record<string, number>;
};
```

This allows barriers to make decisions from explicit signals rather than freeform text.

## Dynamic Stages and Loops

Stages may be:

- pre-scheduled
- materialized after a barrier

This is how the runtime supports:

- parallel reviews
- remediation loops
- escalation
- human checkpoints

Example loop:

`implement -> review -> barrier -> approved ? finalize : remediate -> review`

## Persistence Model

The runtime should be disk-first and log-oriented.

### Source of truth

An append-only workflow event log stores orchestration facts:

- workflow created/completed/failed
- stage materialized/completed
- task scheduled/started/completed
- session attached to task attempt
- barrier evaluated and decision recorded

### Derived state

In-memory state is a projection over the event log and can be rebuilt at any time.

### Rich execution history

Pi sessions remain the system of record for:

- transcripts
- tool usage
- session lineage
- task-local reasoning and context

### Snapshots

Periodic snapshots should speed up recovery by reducing replay cost.

## Recommended Storage Shape

Prefer a log-oriented model regardless of backend:

- **v0**: append-only NDJSON event log if there is a single coordinator
- **next step**: SQLite-backed event log for transactional writes and indexing

## Why This Fits Pi

- Pi already models execution around sessions and session replacement
- `newSession` and `parentSession` naturally express handoff and lineage
- extensions can persist lightweight session-scoped metadata
- the workflow runtime can stay thin and orchestration-focused

## v0 Scope

Build the smallest useful version with:

- single-task stages
- parallel stages
- barrier handlers
- dynamic stage creation
- session-per-task-attempt
- structured task results
- durable event log plus snapshotting
- workflow/stage/task inspection views

## Guiding Principles

1. Session is the execution primitive
2. Stage is the scheduling primitive
3. Barrier is the control-flow primitive
4. Structured result is the decision primitive
5. Fresh attempts should usually create fresh sessions
6. The workflow store should stay thin
7. Pi remains the rich execution system of record
