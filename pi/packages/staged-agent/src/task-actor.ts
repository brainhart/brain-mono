import { Actor, Deferred, type ActorRef } from "./actor.js";
import type {
	TaskDefinition,
	TaskExecutor,
	TaskAttemptId,
	SessionId,
	StageId,
} from "./types.js";
import type { StageActorMsg } from "./stage-actor.js";
import type { SessionPoolMsg } from "./session-pool-actor.js";
import type { EventLog } from "./event-log.js";

export type TaskActorMsg =
	| { type: "run" }
	| { type: "cancel" };

export type TaskActorOpts = {
	jobId: string;
	stageId: StageId;
	stageAttemptId: string;
	taskId: string;
	attemptNumber: number;
	taskAttemptId: TaskAttemptId;
};

/**
 * Leaf actor. Acquires a session, executes a single task, sends the
 * result back to its parent StageActor, and stops.
 */
export class TaskActor extends Actor<TaskActorMsg> {
	constructor(
		private readonly task: TaskDefinition,
		private readonly opts: TaskActorOpts,
		private readonly executor: TaskExecutor,
		private readonly pool: ActorRef<SessionPoolMsg>,
		private readonly parent: ActorRef<StageActorMsg>,
		private readonly log: EventLog,
	) {
		super();
	}

	protected async handle(msg: TaskActorMsg): Promise<void> {
		switch (msg.type) {
			case "run":
				await this.execute();
				break;
			case "cancel":
				this.stop();
				break;
		}
	}

	private async execute(): Promise<void> {
		if (this.stopped) return;

		const sessionDeferred = new Deferred<SessionId>();
		this.pool.send({ type: "acquire", deferred: sessionDeferred });
		let sessionId: SessionId;

		try {
			sessionId = await sessionDeferred.promise;
		} catch {
			if (this.stopped) return;
			this.parent.send({
				type: "task_failed",
				taskId: this.opts.taskId,
				taskAttemptId: this.opts.taskAttemptId,
				error: "Failed to acquire session",
			});
			this.stop();
			return;
		}

		if (this.stopped) {
			this.pool.send({ type: "release", sessionId });
			return;
		}

		this.log.append({
			type: "session_attached",
			jobId: this.opts.jobId,
			taskAttemptId: this.opts.taskAttemptId,
			sessionId,
			timestamp: Date.now(),
		});

		this.log.append({
			type: "task_started",
			jobId: this.opts.jobId,
			stageId: this.opts.stageId,
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			stageAttemptId: this.opts.stageAttemptId,
			attemptNumber: this.opts.attemptNumber,
			timestamp: Date.now(),
		});

		try {
			const result = await this.executor(this.task, sessionId);

			this.log.append({
				type: "task_completed",
				jobId: this.opts.jobId,
				stageId: this.opts.stageId,
				taskId: this.opts.taskId,
				taskAttemptId: this.opts.taskAttemptId,
				result,
				timestamp: Date.now(),
			});

			if (this.stopped) return;
			this.parent.send({
				type: "task_completed",
				taskId: this.opts.taskId,
				taskAttemptId: this.opts.taskAttemptId,
				result,
			});
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.log.append({
				type: "task_failed",
				jobId: this.opts.jobId,
				stageId: this.opts.stageId,
				taskId: this.opts.taskId,
				taskAttemptId: this.opts.taskAttemptId,
				error,
				timestamp: Date.now(),
			});

			if (this.stopped) return;
			this.parent.send({
				type: "task_failed",
				taskId: this.opts.taskId,
				taskAttemptId: this.opts.taskAttemptId,
				error,
			});
		} finally {
			this.pool.send({ type: "release", sessionId });
			this.stop();
		}
	}
}
