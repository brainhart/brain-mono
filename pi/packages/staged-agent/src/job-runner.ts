import { randomUUID } from "node:crypto";
import type {
	JobDefinition,
	JobId,
	JobResult,
	JobStatus,
	JobSnapshot,
	StageId,
	StreamingTaskExecutor,
	TaskResult,
} from "./types.js";
import { MutableDAG } from "./dag.js";
import { EventLog } from "./event-log.js";
import { SessionPoolActor } from "./session-pool-actor.js";
import { DAGSchedulerActor } from "./dag-scheduler-actor.js";
import { projectState } from "./state.js";

export type JobRunnerOpts = {
	eventLogPath?: string;
	concurrency?: number;
	/** When true, the scheduler emits job_resumed instead of job_submitted. */
	isRecovery?: boolean;
};

/**
 * Top-level entry point. Creates the actor system (SessionPoolActor +
 * DAGSchedulerActor), sends the Start message, and awaits completion.
 */
export class JobRunner {
	private scheduler: DAGSchedulerActor | undefined;
	private pool: SessionPoolActor | undefined;
	private readonly log: EventLog;
	readonly jobId: JobId;

	private readonly concurrency?: number;
	private readonly isRecovery: boolean;

	constructor(
		private readonly definition: JobDefinition,
		private readonly executor: StreamingTaskExecutor,
		opts?: JobRunnerOpts,
	) {
		this.jobId = definition.id ?? randomUUID();
		this.log = new EventLog(opts?.eventLogPath);
		this.concurrency = opts?.concurrency;
		this.isRecovery = opts?.isRecovery ?? false;
	}

	async run(): Promise<JobResult> {
		const dag = MutableDAG.fromDefinition(
			this.definition.stages,
			this.definition.dependencies,
		);

		this.pool = new SessionPoolActor(this.concurrency);
		this.scheduler = new DAGSchedulerActor(
			this.jobId,
			dag,
			this.executor,
			this.pool.ref(),
			this.log,
		);

		this.scheduler.send({ type: "start", recovery: this.isRecovery });

		try {
			const stageResults: Map<StageId, TaskResult[]> =
				await this.scheduler.completion.promise;

			return {
				jobId: this.jobId,
				status: "completed",
				stageResults,
			};
		} catch (err) {
			return {
				jobId: this.jobId,
				status: "failed",
				stageResults: this.scheduler.getStageResults(),
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			this.pool.send({ type: "dispose" });
			this.log.close();
		}
	}

	/**
	 * Pause the job. Running tasks continue to completion but no new
	 * stages will be scheduled until `resume()` is called.
	 */
	pause(reason?: string): void {
		this.scheduler?.send({ type: "pause", reason });
	}

	cancel(): void {
		this.scheduler?.send({ type: "cancel" });
	}

	/**
	 * Resume a paused job, optionally with human input.
	 * The input is logged and can be consumed by subsequent transitions.
	 */
	resume(input?: string): void {
		this.scheduler?.send({ type: "resume", input });
	}

	/**
	 * Cancel a single running task. The task's retry policy still applies
	 * — cancellation counts as a failed attempt.
	 */
	cancelTask(taskId: string, stageId: StageId): void {
		this.scheduler?.send({ type: "cancel_task", taskId, stageId });
	}

	getJobStatus(): JobStatus {
		return this.scheduler?.getJobStatus() ?? "pending";
	}

	inspect(): JobSnapshot | undefined {
		return this.scheduler?.inspect();
	}

	getEventLog(): EventLog {
		return this.log;
	}

	/**
	 * Recover a job from a previously-written event log.
	 *
	 * Replays the log to rebuild `JobState`, then returns the projected
	 * state so the caller can inspect where the job left off.
	 *
	 * If the job was still running when the process crashed, the caller
	 * can construct a new `JobRunner` and re-run — completed stages won't
	 * re-execute because the DAGScheduler will see them in the event log
	 * and skip them.
	 */
	static recover(
		eventLogPath: string,
		definition: JobDefinition,
		executor: StreamingTaskExecutor,
	): RecoveredJob {
		const events = EventLog.replay(eventLogPath);
		const state = projectState(events);

		if (state.status === "completed" || state.status === "failed") {
			return { state, alreadyTerminal: true };
		}

		const completedStageIds = new Set<StageId>();
		for (const [sid, ss] of state.stages) {
			if (ss.status === "completed") completedStageIds.add(sid);
		}

		const remainingStageIds = new Set(
			definition.stages
				.filter((s) => !completedStageIds.has(s.id))
				.map((s) => s.id),
		);

		const remainingStages = definition.stages.filter((s) =>
			remainingStageIds.has(s.id),
		);

		const remainingDeps = definition.dependencies.filter(
			(d) =>
				remainingStageIds.has(d.parentStageId) &&
				remainingStageIds.has(d.childStageId),
		);

		const resumeDef: JobDefinition = {
			id: state.jobId,
			stages: remainingStages,
			dependencies: remainingDeps,
		};

		const runner = new JobRunner(resumeDef, executor, {
			eventLogPath,
			isRecovery: true,
		});

		return { state, alreadyTerminal: false, runner };
	}
}

export type RecoveredJob =
	| { state: ReturnType<typeof projectState>; alreadyTerminal: true }
	| {
			state: ReturnType<typeof projectState>;
			alreadyTerminal: false;
			runner: JobRunner;
	  };
