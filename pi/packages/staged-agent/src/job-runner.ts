import { randomUUID } from "node:crypto";
import type {
	JobDefinition,
	JobId,
	JobResult,
	StageId,
	TaskExecutor,
	TaskResult,
	SessionPool,
} from "./types.js";
import { MutableDAG } from "./dag.js";
import { EventLog } from "./event-log.js";
import { DAGScheduler } from "./dag-scheduler.js";
import { TaskRunner } from "./task-runner.js";

export type JobRunnerOpts = {
	eventLogPath?: string;
};

/**
 * Top-level entry point for executing a Job. Owns the lifecycle of a
 * single job: builds the DAG, wires up the scheduler, drives the event
 * loop, and exposes results.
 */
export class JobRunner {
	private scheduler: DAGScheduler | undefined;
	private readonly log: EventLog;
	readonly jobId: JobId;

	constructor(
		private readonly definition: JobDefinition,
		private readonly pool: SessionPool,
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

		const runner = new TaskRunner(this.pool, this.executor, this.log);
		this.scheduler = new DAGScheduler(
			this.jobId,
			dag,
			runner,
			this.log,
		);

		try {
			const stageResults: Map<StageId, TaskResult[]> =
				await this.scheduler.start();

			return {
				jobId: this.jobId,
				status: "completed",
				stageResults,
			};
		} catch (err) {
			return {
				jobId: this.jobId,
				status: "failed",
				stageResults: new Map(),
				error: err instanceof Error ? err.message : String(err),
			};
		} finally {
			this.log.close();
		}
	}

	getEventLog(): EventLog {
		return this.log;
	}
}
