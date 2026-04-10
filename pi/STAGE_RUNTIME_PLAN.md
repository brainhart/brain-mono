# Stage-Based Agent Runtime Plan

## Summary

Build a DAG-scheduled agent runtime on top of Pi's native session runtime,
using the same conceptual architecture as Apache Spark's driver-side execution
engine.

- **Pi runtime** remains the session execution primitive (analogous to a Spark
  executor).
- **DAGScheduler** becomes the orchestration layer (analogous to Spark's
  DAGScheduler + TaskScheduler).
- **Runtime state** is log-oriented on disk, with in-memory state treated as a
  projection/cache (analogous to Spark's EventLoggingListener + History
  Server).

### Core model (Spark-aligned)

| Concept | Spark analog | Definition |
|---------|-------------|------------|
| **Job** | Job | A top-level unit of work submitted to the runtime. A job produces a DAG of stages. |
| **Stage** | Stage (ShuffleMapStage / ResultStage) | A scheduling boundary: a set of tasks that can run in parallel without data exchange between them. |
| **StageAttempt** | StageAttempt | One attempt to complete a stage. A new attempt is created on stage-level retry. |
| **TaskSet** | TaskSet | The batch of tasks for a single stage attempt. |
| **Task** | Task | The smallest schedulable unit of work. Declarative: prompt, context, config. |
| **TaskAttempt** | TaskAttempt | One execution of a task in a Pi session. |
| **TaskResult** | DirectTaskResult | Structured output from a completed task attempt. |
| **StageDependency** | ShuffleDependency | A directed edge in the stage DAG. Carries an optional transition function for adaptive replanning. |

## Goals

- Stay Pi-native by treating sessions as the execution unit
- Model orchestration as a DAG of stages, scheduled in dependency order
- Support sequential, parallel, and dynamically materialized stages
- Support adaptive replanning at stage boundaries (Spark AQE-style)
- Support loops such as "repeat until approved"
- Make decisions from structured task outputs, not transcript scraping
- Support restart/recovery from durable on-disk state

## Non-goals for v0

- Full distributed scheduling across multiple hosts
- A second transcript store parallel to Pi sessions
- Partition-level data locality (irrelevant for agent workloads)
- Speculative execution

## Architecture

### 1. SessionPool

Spark analog: **SchedulerBackend + ExecutorPool**

Manages the pool of Pi session execution slots. Wraps Pi's
`AgentSessionRuntime` pattern.

Responsibilities:

- create, resume, and dispose Pi sessions
- rebind session-local listeners after session replacement
- provide execution slots to TaskRunner on demand
- enforce concurrency limits

### 2. TaskRunner

Spark analog: **TaskRunner** (the per-executor component that runs a task)

Runs a single task attempt in one Pi session.

Responsibilities:

- prepare task prompt and context
- acquire a session from SessionPool
- drive the session to completion
- collect a structured TaskResult
- release the session back to the pool

### 3. TaskSetManager

Spark analog: **TaskSetManager**

Manages one stage attempt's worth of tasks.

Responsibilities:

- track per-task state: pending / running / completed / failed
- dispatch tasks to TaskRunner
- handle task-level retries (up to a configurable max)
- evaluate the stage's completion policy
- report stage attempt outcome to DAGScheduler

### 4. DAGScheduler

Spark analog: **DAGScheduler**

The central brain. Maintains the stage DAG, submits stages in dependency
order, and handles stage completion — including adaptive replanning.

Responsibilities:

- build and maintain the stage DAG for a job
- submit stages when all parent stages are complete
  (`submitStage` → check missing parents → recurse or `submitMissingTasks`)
- manage stage lifecycle via the state machine:
  `waiting → running → completed | failed`
- on stage completion: evaluate transition functions on outgoing
  StageDependencies (the adaptive/barrier behavior)
- on stage failure: resubmit as a new StageAttempt or fail dependent stages
- materialize dynamically created stages into the DAG
- coordinate the `waitingStages` / `runningStages` / `failedStages` sets

### 5. JobRunner

Spark analog: **SparkContext + Driver event loop**

Top-level entry point. Owns the lifecycle of a single job.

Responsibilities:

- accept a job definition (initial stage DAG + transition functions)
- create a DAGScheduler for the job
- drive the event loop: receive events, dispatch to DAGScheduler
- expose job status and results to callers
- manage job-level lifecycle: running → completed / failed / paused

## Execution Model

Mirrors Spark's DAGScheduler flow:

1. Submit a **Job** with an initial stage DAG
2. DAGScheduler calls `submitStage(finalStage)`
3. `submitStage` checks for missing parent stages
   - missing parents → add stage to `waitingStages`, recurse on parents
   - no missing parents → create **TaskSet** → hand to **TaskSetManager**
4. TaskSetManager dispatches each **Task** to a **TaskRunner**
5. TaskRunner acquires a session from **SessionPool**, runs the task,
   collects a **TaskResult**
6. TaskSetManager evaluates the completion policy
   - all tasks done per policy → report stage attempt completed
   - task failed → retry as new TaskAttempt (up to max retries)
   - too many failures → report stage attempt failed
7. DAGScheduler receives stage completion event
   - evaluate **transition functions** on outgoing StageDependencies
     (this is where adaptive/barrier logic lives)
   - materialize any dynamically created downstream stages
   - scan `waitingStages` for newly unblocked stages → `submitStage`
8. On stage failure:
   - retry? → create new **StageAttempt**, resubmit
   - give up? → fail dependent stages, fail the job
9. Repeat until the final stage completes, the job pauses, or the job fails

## Stage Model

Stages are DAG nodes. Stage dependencies are DAG edges.

### Stage examples

- planning
- implementation (may fan out into parallel tasks)
- review (parallel reviewers)
- remediation
- adjudication
- human approval (pauses the job until external input)

### Completion policies

Applied per-stage by TaskSetManager:

- `all` — every task in the TaskSet must succeed (Spark's default)
- `quorum(n)` — at least n tasks must succeed
- `first_success` — stage completes as soon as one task succeeds
- `predicate(fn)` — custom function over the collected TaskResults

### Stage dependencies and transitions

A StageDependency connects a parent stage to a child stage. It may carry a
**transition function** that runs when the parent completes:

```ts
type TransitionFn = (
  parentResults: TaskResult[],
  dag: MutableDAG,
) => void;
```

The transition function can:

- inspect parent outputs
- add new stages and edges to the DAG (dynamic materialization)
- mark the job as paused pending external input
- do nothing (static dependency, Spark's default behavior)

This is the mechanism for adaptive replanning (Spark AQE-style). The old
"barrier" concept is now just a transition function on a StageDependency.

### Example: review loop

```
implement → review → [transition] → approved ? finalize : remediate → review
```

The transition function after the review stage inspects the review
TaskResults. If all reviewers approve, it materializes a `finalize` stage.
Otherwise, it materializes a `remediate` stage with an edge back to `review`,
creating a cycle in the DAG that terminates on approval.

## Stage Attempts

Spark models stage attempts explicitly, and so should we.

When a stage fails (e.g., all task retries exhausted, session errors),
DAGScheduler may resubmit it as a new StageAttempt with an incremented attempt
ID. Benefits:

- clean separation between "stage failed once" and "stage permanently failed"
- each attempt gets its own TaskSet and TaskResults
- makes remediation loops and retry policies composable

## Task Model

Each task attempt runs in a fresh Pi session.

Benefits (same as Spark's executor isolation):

- role isolation
- clean lineage via `parentSession`
- easier retries (no stale state)
- independent reviews
- simpler recovery

### TaskResult

Each task emits a structured result:

```ts
type TaskResult = {
  status: "success" | "failure" | "blocked";
  summary: string;
  artifacts?: string[];
  signals?: Record<string, unknown>;
  metrics?: Record<string, number>;
};
```

Transition functions make decisions from these structured signals rather than
scraping freeform transcripts.

## Persistence Model

The runtime is disk-first and log-oriented, mirroring Spark's event logging
architecture.

### Source of truth

An append-only event log stores orchestration facts:

- `JobSubmitted` / `JobCompleted` / `JobFailed`
- `StageSubmitted` / `StageCompleted` / `StageFailed`
- `StageAttemptStarted` / `StageAttemptCompleted` / `StageAttemptFailed`
- `TaskStarted` / `TaskCompleted` / `TaskFailed`
- `SessionAttached` (links a TaskAttempt to a Pi session)
- `TransitionEvaluated` (records the decision and any new stages materialized)

### Derived state

In-memory state (`waitingStages`, `runningStages`, `failedStages`, task
status maps) is a projection over the event log and can be rebuilt at any
time.

### Rich execution history

Pi sessions remain the system of record for:

- transcripts
- tool usage
- session lineage (`newSession`, `parentSession`)
- task-local reasoning and context

### Snapshots

Periodic snapshots speed up recovery by reducing replay cost.

## Recommended Storage Shape

Prefer a log-oriented model regardless of backend:

- **v0**: append-only NDJSON event log for a single-coordinator runtime
- **next step**: SQLite-backed event log for transactional writes and
  indexing

## Why This Fits Pi

- Pi already models execution around sessions and session replacement
- `newSession` and `parentSession` naturally express task attempt lineage
- extensions can persist lightweight session-scoped metadata
- the runtime stays thin and orchestration-focused — Pi remains the rich
  execution engine
- Spark's driver-side architecture maps almost 1:1 because both systems
  schedule isolated units of work (tasks/sessions) across a DAG of stages

## Component Mapping

| This runtime | Spark | Pi |
|-------------|-------|-----|
| JobRunner | SparkContext + Driver | — (new) |
| DAGScheduler | DAGScheduler | — (new) |
| TaskSetManager | TaskSetManager | — (new) |
| TaskRunner | TaskRunner | wraps `AgentSession` |
| SessionPool | SchedulerBackend + ExecutorPool | wraps `AgentSessionRuntime` |
| Job | Job | — (new concept) |
| Stage | Stage | — (new concept) |
| StageAttempt | StageAttempt | — (new concept) |
| TaskSet | TaskSet | — (new concept) |
| Task | Task | prompt + context |
| TaskAttempt | TaskAttempt | one Pi session execution |
| TaskResult | DirectTaskResult | structured output |
| StageDependency | ShuffleDependency | DAG edge + optional transition fn |
| Event log | EventLoggingListener | NDJSON / SQLite |

## v0 Scope

Build the smallest useful version with:

- Job submission and lifecycle
- DAGScheduler with `waitingStages` / `runningStages` / `failedStages`
  state machine
- Single-task and multi-task stages
- Parallel stage execution
- TaskSetManager with `all` and `first_success` completion policies
- Transition functions on stage dependencies (replaces barriers)
- Dynamic stage materialization
- Session-per-task-attempt via SessionPool
- Structured TaskResults
- Task-level retries
- Stage-level retries (StageAttempt)
- Durable append-only event log
- Event log projection for in-memory state recovery
- Job/stage/task inspection views

## Guiding Principles

1. **Session is the execution primitive** — Pi sessions are executors
2. **Stage is the scheduling primitive** — DAGScheduler submits stages in
   dependency order
3. **Transition function is the control-flow primitive** — adaptive
   replanning lives on DAG edges, not in a separate processor
4. **Structured result is the decision primitive** — transition functions
   operate on TaskResults, not transcripts
5. **Fresh attempts create fresh sessions** — isolation by default
6. **The event log is the source of truth** — in-memory state is a
   projection
7. **Pi remains the rich execution system of record** — the runtime stays
   thin
