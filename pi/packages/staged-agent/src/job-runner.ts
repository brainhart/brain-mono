import { randomUUID } from "node:crypto";
import type {
	JobDefinition,
	JobId,
	JobResult,
	JobStatus,
	JobSnapshot,
	StageId,
	TaskExecutor,
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

	constructor(
		private readonly definition: JobDefinition,
		private readonly executor: TaskExecutor,
		opts?: JobRunnerOpts,
	) {
		this.jobId = definition.id ?? randomUUID();
		this.log = new EventLog(opts?.eventLogPath);
	}

	async run(): Promise<JobResult> {
		const dag = MutableDAG.fromDefinition(
			this.definition.stages,
			this.definition.dependencies,
		);

		this.pool = new SessionPoolActor();
		this.scheduler = new DAGSchedulerActor(
			this.jobId,
			dag,
			this.executor,
			this.pool.ref(),
			this.log,
		);

		this.scheduler.send({ type: "start" });

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

	cancel(): void {
		this.scheduler?.send({ type: "cancel" });
	}

	/**
	 * Resume a paused job. The scheduler will continue scheduling
	 * waiting stages.
	 */
	resume(): void {
		this.scheduler?.send({ type: "resume" });
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
		executor: TaskExecutor,
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

		const remainingStages = definition.stages.filter(
			(s) => !completedStageIds.has(s.id),
		);

		const remainingDeps = definition.dependencies.filter(
			(d) =>
				!completedStageIds.has(d.parentStageId) ||
				!completedStageIds.has(d.childStageId),
		);

		const resumeDef: JobDefinition = {
			id: state.jobId,
			stages: remainingStages,
			dependencies: remainingDeps,
		};

		const runner = new JobRunner(resumeDef, executor, {
			eventLogPath,
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
