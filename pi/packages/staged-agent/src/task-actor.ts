import { Actor, Deferred, type ActorRef, type TimerHandle } from "./actor.js";
import type {
	TaskDefinition,
	TaskAttemptId,
	SessionId,
	StageId,
	StreamingTaskExecutor,
} from "./types.js";
import type { StageActorMsg } from "./stage-actor.js";
import type { SessionPoolMsg } from "./session-pool-actor.js";
import type { EventLog } from "./event-log.js";

type Phase = "idle" | "acquiring" | "executing" | "done";

export type TaskActorMsg =
	| { type: "run" }
	| { type: "session_acquired"; sessionId: SessionId }
	| { type: "session_acquire_failed"; error: string }
	| { type: "execute_completed"; result: import("./types.js").TaskResult }
	| { type: "execute_failed"; error: string }
	| { type: "acquire_timeout" }
	| { type: "execute_timeout" }
	| { type: "cancel" };

export type TaskActorOpts = {
	jobId: string;
	stageId: StageId;
	stageAttemptId: string;
	taskId: string;
	attemptNumber: number;
	taskAttemptId: TaskAttemptId;
	acquireTimeoutMs?: number;
	executeTimeoutMs?: number;
};

/**
 * Leaf actor. Message-driven state machine — no `await` inside handlers.
 *
 * Phases: idle → acquiring → executing → done
 *
 * Async operations (session acquire, executor) bridge their results
 * back into the mailbox via `.then() → self.send()`. Timeout messages
 * are scheduled via `sendDelayed` and cancelled when the operation
 * completes, so they are processed normally by the drain loop.
 */
export class TaskActor extends Actor<TaskActorMsg> {
	private phase: Phase = "idle";
	private sessionId: SessionId | undefined;
	private acquireTimer: TimerHandle | undefined;
	private executeTimer: TimerHandle | undefined;
	private abortController: AbortController | undefined;

	constructor(
		private readonly task: TaskDefinition,
		private readonly opts: TaskActorOpts,
		private readonly executor: StreamingTaskExecutor,
		private readonly pool: ActorRef<SessionPoolMsg>,
		private readonly parent: ActorRef<StageActorMsg>,
		private readonly log: EventLog,
	) {
		super();
	}

	protected override onDeadLetter(msg: TaskActorMsg): void {
		if (msg.type === "session_acquired") {
			this.pool.send({ type: "release", sessionId: msg.sessionId });
		}
	}

	protected handle(msg: TaskActorMsg): void {
		switch (msg.type) {
			case "run":
				this.onRun();
				break;
			case "session_acquired":
				this.onSessionAcquired(msg.sessionId);
				break;
			case "session_acquire_failed":
				this.onSessionAcquireFailed(msg.error);
				break;
			case "execute_completed":
				this.onExecuteCompleted(msg.result);
				break;
			case "execute_failed":
				this.onExecuteFailed(msg.error);
				break;
			case "acquire_timeout":
				this.onAcquireTimeout();
				break;
			case "execute_timeout":
				this.onExecuteTimeout();
				break;
			case "cancel":
				this.fail("Task cancelled");
				break;
		}
	}

	private onRun(): void {
		if (this.phase !== "idle") return;
		this.phase = "acquiring";

		const deferred = new Deferred<SessionId>();
		this.pool.send({ type: "acquire", deferred });

		const self = this.ref();
		deferred.promise.then(
			(sessionId) => self.send({ type: "session_acquired", sessionId }),
			(err) =>
				self.send({
					type: "session_acquire_failed",
					error: err instanceof Error ? err.message : String(err),
				}),
		);

		if (this.opts.acquireTimeoutMs !== undefined) {
			this.acquireTimer = this.sendDelayed(
				{ type: "acquire_timeout" },
				this.opts.acquireTimeoutMs,
			);
		}
	}

	private onSessionAcquired(sessionId: SessionId): void {
		if (this.phase !== "acquiring") {
			this.pool.send({ type: "release", sessionId });
			return;
		}

		if (this.acquireTimer) {
			this.cancelDelayed(this.acquireTimer);
			this.acquireTimer = undefined;
		}

		this.sessionId = sessionId;
		this.phase = "executing";

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

		this.abortController = new AbortController();
		const self = this.ref();

		const onProgress = (progress: import("./types.js").TaskProgress) => {
			if (this.phase !== "executing") return;
			this.log.append({
				type: "task_progress",
				jobId: this.opts.jobId,
				stageId: this.opts.stageId,
				taskId: this.opts.taskId,
				taskAttemptId: this.opts.taskAttemptId,
				progress,
				timestamp: Date.now(),
			});
		};

		this.executor(this.task, sessionId, this.abortController.signal, onProgress).then(
			(result) => self.send({ type: "execute_completed", result }),
			(err) =>
				self.send({
					type: "execute_failed",
					error: err instanceof Error ? err.message : String(err),
				}),
		);

		if (this.opts.executeTimeoutMs !== undefined) {
			this.executeTimer = this.sendDelayed(
				{ type: "execute_timeout" },
				this.opts.executeTimeoutMs,
			);
		}
	}

	private onSessionAcquireFailed(error: string): void {
		if (this.phase !== "acquiring") return;
		if (this.acquireTimer) {
			this.cancelDelayed(this.acquireTimer);
			this.acquireTimer = undefined;
		}
		this.fail(error);
	}

	private onExecuteCompleted(
		result: import("./types.js").TaskResult,
	): void {
		if (this.phase !== "executing") return;
		if (this.executeTimer) {
			this.cancelDelayed(this.executeTimer);
			this.executeTimer = undefined;
		}

		this.log.append({
			type: "task_completed",
			jobId: this.opts.jobId,
			stageId: this.opts.stageId,
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			result,
			timestamp: Date.now(),
		});

		this.parent.send({
			type: "task_completed",
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			result,
		});

		this.releaseAndStop();
	}

	private onExecuteFailed(error: string): void {
		if (this.phase !== "executing") return;
		if (this.executeTimer) {
			this.cancelDelayed(this.executeTimer);
			this.executeTimer = undefined;
		}

		this.log.append({
			type: "task_failed",
			jobId: this.opts.jobId,
			stageId: this.opts.stageId,
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			error,
			timestamp: Date.now(),
		});

		this.parent.send({
			type: "task_failed",
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			error,
		});

		this.releaseAndStop();
	}

	private onAcquireTimeout(): void {
		if (this.phase !== "acquiring") return;
		this.acquireTimer = undefined;
		this.fail("Session acquire timed out");
	}

	private onExecuteTimeout(): void {
		if (this.phase !== "executing") return;
		this.executeTimer = undefined;
		this.abortController?.abort();

		this.log.append({
			type: "task_failed",
			jobId: this.opts.jobId,
			stageId: this.opts.stageId,
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			error: "Task execution timed out",
			timestamp: Date.now(),
		});

		this.parent.send({
			type: "task_failed",
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			error: "Task execution timed out",
		});

		this.releaseAndStop();
	}

	private fail(error: string): void {
		this.abortController?.abort();

		if (this.phase !== "idle") {
			this.log.append({
				type: "task_failed",
				jobId: this.opts.jobId,
				stageId: this.opts.stageId,
				taskId: this.opts.taskId,
				taskAttemptId: this.opts.taskAttemptId,
				error,
				timestamp: Date.now(),
			});
		}

		this.parent.send({
			type: "task_failed",
			taskId: this.opts.taskId,
			taskAttemptId: this.opts.taskAttemptId,
			error,
		});
		this.releaseAndStop();
	}

	private releaseAndStop(): void {
		this.phase = "done";
		if (this.sessionId) {
			this.pool.send({ type: "release", sessionId: this.sessionId });
			this.sessionId = undefined;
		}
		this.stop();
	}
}
