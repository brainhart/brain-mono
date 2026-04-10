import { randomUUID } from "node:crypto";
import type {
	JobDefinition,
	JobId,
	JobResult,
	StageId,
	TaskExecutor,
	TaskResult,
} from "./types.js";
import { MutableDAG } from "./dag.js";
import { EventLog } from "./event-log.js";
import { SessionPoolActor } from "./session-pool-actor.js";
import { DAGSchedulerActor } from "./dag-scheduler-actor.js";

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

		this.pool = new SessionPoolActor(
			/* concurrency — default Infinity for v0 */
		);
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

	getEventLog(): EventLog {
		return this.log;
	}
}
