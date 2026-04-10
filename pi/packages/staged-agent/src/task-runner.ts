import type {
	TaskDefinition,
	TaskResult,
	TaskExecutor,
	SessionPool,
	TaskAttemptId,
} from "./types.js";
import type { EventLog } from "./event-log.js";
import type { RuntimeEvent } from "./events.js";

export type TaskRunnerOpts = {
	jobId: string;
	stageAttemptId: string;
	taskId: string;
	attemptNumber: number;
	taskAttemptId: TaskAttemptId;
};

/**
 * Runs a single task attempt: acquires a session, executes, collects a
 * `TaskResult`, and releases the session.
 */
export class TaskRunner {
	constructor(
		private readonly pool: SessionPool,
		private readonly executor: TaskExecutor,
		private readonly log: EventLog,
	) {}

	async run(
		task: TaskDefinition,
		opts: TaskRunnerOpts,
	): Promise<TaskResult> {
		const sessionId = await this.pool.acquire();

		this.emit({
			type: "session_attached",
			jobId: opts.jobId,
			taskAttemptId: opts.taskAttemptId,
			sessionId,
			timestamp: Date.now(),
		});

		this.emit({
			type: "task_started",
			jobId: opts.jobId,
			taskId: opts.taskId,
			taskAttemptId: opts.taskAttemptId,
			stageAttemptId: opts.stageAttemptId,
			attemptNumber: opts.attemptNumber,
			timestamp: Date.now(),
		});

		try {
			const result = await this.executor(task, sessionId);

			this.emit({
				type: "task_completed",
				jobId: opts.jobId,
				taskId: opts.taskId,
				taskAttemptId: opts.taskAttemptId,
				result,
				timestamp: Date.now(),
			});

			return result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.emit({
				type: "task_failed",
				jobId: opts.jobId,
				taskId: opts.taskId,
				taskAttemptId: opts.taskAttemptId,
				error: msg,
				timestamp: Date.now(),
			});
			throw err;
		} finally {
			await this.pool.release(sessionId);
		}
	}

	private emit(event: RuntimeEvent): void {
		this.log.append(event);
	}
}
