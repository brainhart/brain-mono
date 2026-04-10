import { Actor, type ActorRef } from "./actor.js";
import type {
	TaskDefinition,
	TaskResult,
	StreamingTaskExecutor,
	CompletionPolicy,
	StageId,
	StageAttemptId,
	TaskAttemptId,
	TaskOperatorAction,
	TaskOperatorNote,
} from "./types.js";
import type { DAGSchedulerActorMsg } from "./dag-scheduler-actor.js";
import type { SessionPoolMsg } from "./session-pool-actor.js";
import type { EventLog } from "./event-log.js";
import { TaskActor } from "./task-actor.js";

export type StageActorMsg =
	| { type: "run" }
	| {
			type: "task_completed";
			taskId: string;
			taskAttemptId: TaskAttemptId;
			result: TaskResult;
	  }
	| {
			type: "task_failed";
			taskId: string;
			taskAttemptId: TaskAttemptId;
			error: string;
	  }
	| {
			type: "task_operator_note";
			taskId: string;
			note: string;
			action: TaskOperatorAction;
	  }
	| {
			type: "retry_task_with_note";
			taskId: string;
			note: string;
	  }
	| { type: "cancel" }
	| { type: "cancel_task"; taskId: string };

type TaskSlot = {
	task: TaskDefinition;
	attemptCount: number;
	result?: TaskResult;
	done: boolean;
	activeActor?: TaskActor;
	/** The attempt ID of the currently active actor, used to discard stale messages. */
	activeAttemptId?: TaskAttemptId;
	operatorNotes: TaskOperatorNote[];
	retryGuidance: string[];
};

export type StageActorOpts = {
	completionPolicy?: CompletionPolicy;
	maxTaskAttempts?: number;
	taskTimeoutMs?: number;
	acquireTimeoutMs?: number;
};

/**
 * Manages one stage-attempt's worth of tasks.
 *
 * Spawns TaskActors for each task, processes their completion/failure
 * messages one at a time (mailbox-serialised), applies the completion
 * policy, handles task-level retries, and reports back to its parent
 * DAGSchedulerActor.
 */
export class StageActor extends Actor<StageActorMsg> {
	private readonly slots = new Map<string, TaskSlot>();
	private readonly results: TaskResult[] = [];
	private readonly completionPolicy: CompletionPolicy;
	private readonly maxTaskAttempts: number;
	private readonly taskTimeoutMs?: number;
	private readonly acquireTimeoutMs?: number;
	private finished = false;

	constructor(
		private readonly stageId: StageId,
		private readonly stageAttemptId: StageAttemptId,
		private readonly jobId: string,
		private readonly tasks: TaskDefinition[],
		private readonly executor: StreamingTaskExecutor,
		private readonly pool: ActorRef<SessionPoolMsg>,
		private readonly parent: ActorRef<DAGSchedulerActorMsg>,
		private readonly log: EventLog,
		opts?: StageActorOpts,
	) {
		super();
		this.completionPolicy = opts?.completionPolicy ?? { type: "all" };
		this.maxTaskAttempts = opts?.maxTaskAttempts ?? 3;
		this.taskTimeoutMs = opts?.taskTimeoutMs;
		this.acquireTimeoutMs = opts?.acquireTimeoutMs;
		for (const t of tasks) {
			this.slots.set(t.id, {
				task: t,
				attemptCount: 0,
				done: false,
				operatorNotes: [],
				retryGuidance: [],
			});
		}
	}

	protected handle(msg: StageActorMsg): void {
		if (this.finished) return;

		switch (msg.type) {
			case "run":
				this.spawnAll();
				break;

			case "task_completed":
				this.onTaskCompleted(msg.taskId, msg.taskAttemptId, msg.result);
				break;

			case "task_failed":
				this.onTaskFailed(msg.taskId, msg.taskAttemptId, msg.error);
				break;

			case "task_operator_note":
				this.onTaskOperatorNote(msg.taskId, msg.note, msg.action);
				break;

			case "retry_task_with_note":
				this.onRetryTaskWithNote(msg.taskId, msg.note);
				break;

			case "cancel":
				this.cancelAll();
				break;

			case "cancel_task":
				this.cancelSingleTask(msg.taskId);
				break;
		}
	}

	private spawnAll(): void {
		if (this.slots.size === 0) {
			this.finish("completed");
			return;
		}
		for (const [, slot] of this.slots) {
			this.spawnTask(slot);
		}
	}

	private spawnTask(slot: TaskSlot): void {
		slot.attemptCount++;
		const taskAttemptId: TaskAttemptId =
			`${slot.task.id}:${this.stageAttemptId}:${slot.attemptCount}`;
		const taskForAttempt = this.buildTaskForAttempt(slot);

		const actor = new TaskActor(
			taskForAttempt,
			{
				jobId: this.jobId,
				stageId: this.stageId,
				stageAttemptId: this.stageAttemptId,
				taskId: slot.task.id,
				attemptNumber: slot.attemptCount,
				taskAttemptId,
				acquireTimeoutMs: this.acquireTimeoutMs,
				executeTimeoutMs: this.taskTimeoutMs,
			},
			this.executor,
			this.pool,
			this.ref(),
			this.log,
		);

		slot.activeActor = actor;
		slot.activeAttemptId = taskAttemptId;
		actor.send({ type: "run" });
	}

	private buildTaskForAttempt(slot: TaskSlot): TaskDefinition {
		if (slot.retryGuidance.length === 0 && slot.operatorNotes.length === 0) {
			return slot.task;
		}

		const operatorNotes = slot.operatorNotes.map((entry) => ({
			action: entry.action,
			note: entry.note,
			timestamp: entry.timestamp,
		}));
		const prompt = slot.retryGuidance.length === 0
			? slot.task.prompt
			: [
				slot.task.prompt,
				"",
				"Operator guidance for this retry:",
				...slot.retryGuidance.map((note, index) => `${index + 1}. ${note}`),
			].join("\n");

		return {
			...slot.task,
			prompt,
			context: {
				...(slot.task.context ?? {}),
				operatorNotes,
				retryGuidance: [...slot.retryGuidance],
			},
		};
	}

	private onTaskCompleted(taskId: string, attemptId: TaskAttemptId, result: TaskResult): void {
		const slot = this.slots.get(taskId);
		if (!slot || slot.done) return;
		if (slot.activeAttemptId !== attemptId) return;

		slot.done = true;
		slot.result = result;
		slot.activeActor = undefined;
		slot.activeAttemptId = undefined;
		this.results.push(result);

		this.checkPolicy();
	}

	private onTaskFailed(taskId: string, attemptId: TaskAttemptId, error: string): void {
		const slot = this.slots.get(taskId);
		if (!slot || slot.done) return;
		if (slot.activeAttemptId !== attemptId) return;

		slot.activeActor = undefined;
		slot.activeAttemptId = undefined;

		if (slot.attemptCount < this.maxTaskAttempts) {
			this.spawnTask(slot);
		} else {
			slot.done = true;
			slot.result = { status: "failure", summary: error };
			this.results.push(slot.result);
			this.checkPolicy();
		}
	}

	private onTaskOperatorNote(
		taskId: string,
		note: string,
		action: TaskOperatorAction,
	): void {
		const slot = this.slots.get(taskId);
		if (!slot) return;
		slot.operatorNotes.push({
			note,
			action,
			timestamp: Date.now(),
		});
	}

	private onRetryTaskWithNote(taskId: string, note: string): void {
		const slot = this.slots.get(taskId);
		if (!slot) return;

		this.onTaskOperatorNote(taskId, note, "retry");
		slot.retryGuidance.push(note);

		if (slot.done && slot.result?.status === "failure" && slot.attemptCount < this.maxTaskAttempts) {
			const idx = this.results.indexOf(slot.result);
			if (idx >= 0) this.results.splice(idx, 1);
			slot.done = false;
			slot.result = undefined;
		}

		if (slot.activeActor) {
			slot.activeActor.send({ type: "cancel" });
			slot.activeActor = undefined;
		} else if (!slot.done && slot.attemptCount < this.maxTaskAttempts) {
			this.spawnTask(slot);
		}
	}

	private checkPolicy(): void {
		if (this.finished) return;

		const successful = this.results.filter((r) => r.status === "success");
		const allDone = [...this.slots.values()].every((s) => s.done);
		const p = this.completionPolicy;

		let policyMet = false;
		switch (p.type) {
			case "all":
				policyMet =
					allDone &&
					successful.length === this.tasks.length &&
					this.results.length === this.tasks.length;
				break;
			case "quorum":
				policyMet = successful.length >= p.n;
				break;
			case "first_success":
				policyMet = successful.length >= 1;
				break;
			case "predicate":
				try {
					policyMet = allDone && p.fn(this.results);
				} catch {
					policyMet = false;
				}
				break;
		}

		if (policyMet) {
			this.finish("completed");
		} else if (allDone) {
			this.finish("failed");
		}
	}

	private finish(outcome: "completed" | "failed"): void {
		this.finished = true;
		this.cancelRunning();

		if (outcome === "completed") {
			this.parent.send({
				type: "stage_completed",
				stageId: this.stageId,
				stageAttemptId: this.stageAttemptId,
				results: [...this.results],
			});
		} else {
			const failedTasks = [...this.slots.values()]
				.filter((s) => s.result?.status !== "success")
				.map((s) => s.task.id);
			this.parent.send({
				type: "stage_failed",
				stageId: this.stageId,
				stageAttemptId: this.stageAttemptId,
				error: `Tasks failed: ${failedTasks.join(", ")}`,
				results: [...this.results],
			});
		}

		this.stop();
	}

	private cancelAll(): void {
		this.finished = true;
		this.cancelRunning();
		this.stop();
	}

	private cancelSingleTask(taskId: string): void {
		const slot = this.slots.get(taskId);
		if (slot?.activeActor) {
			slot.activeActor.send({ type: "cancel" });
			slot.activeActor = undefined;
		}
	}

	private cancelRunning(): void {
		for (const [, slot] of this.slots) {
			if (slot.activeActor) {
				slot.activeActor.send({ type: "cancel" });
				slot.activeActor = undefined;
			}
		}
	}
}
