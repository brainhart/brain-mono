import { Actor, type ActorRef } from "./actor.js";
import type {
	TaskDefinition,
	TaskResult,
	TaskExecutor,
	CompletionPolicy,
	StageId,
	StageAttemptId,
	TaskAttemptId,
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
	| { type: "cancel" };

type TaskSlot = {
	task: TaskDefinition;
	attemptCount: number;
	result?: TaskResult;
	done: boolean;
	activeActor?: TaskActor;
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
	private finished = false;

	constructor(
		private readonly stageId: StageId,
		private readonly stageAttemptId: StageAttemptId,
		private readonly jobId: string,
		private readonly tasks: TaskDefinition[],
		private readonly executor: TaskExecutor,
		private readonly pool: ActorRef<SessionPoolMsg>,
		private readonly parent: ActorRef<DAGSchedulerActorMsg>,
		private readonly log: EventLog,
		opts?: { completionPolicy?: CompletionPolicy; maxTaskAttempts?: number },
	) {
		super();
		this.completionPolicy = opts?.completionPolicy ?? { type: "all" };
		this.maxTaskAttempts = opts?.maxTaskAttempts ?? 3;
		for (const t of tasks) {
			this.slots.set(t.id, { task: t, attemptCount: 0, done: false });
		}
	}

	protected async handle(msg: StageActorMsg): Promise<void> {
		if (this.finished) return;

		switch (msg.type) {
			case "run":
				this.spawnAll();
				break;

			case "task_completed":
				this.onTaskCompleted(msg.taskId, msg.result);
				break;

			case "task_failed":
				this.onTaskFailed(msg.taskId, msg.error);
				break;

			case "cancel":
				this.cancelAll();
				break;
		}
	}

	private spawnAll(): void {
		for (const [, slot] of this.slots) {
			this.spawnTask(slot);
		}
	}

	private spawnTask(slot: TaskSlot): void {
		slot.attemptCount++;
		const taskAttemptId: TaskAttemptId =
			`${slot.task.id}:${this.stageAttemptId}:${slot.attemptCount}`;

		const actor = new TaskActor(
			slot.task,
			{
				jobId: this.jobId,
				stageId: this.stageId,
				stageAttemptId: this.stageAttemptId,
				taskId: slot.task.id,
				attemptNumber: slot.attemptCount,
				taskAttemptId,
			},
			this.executor,
			this.pool,
			this.ref(),
			this.log,
		);

		slot.activeActor = actor;
		actor.send({ type: "run" });
	}

	private onTaskCompleted(taskId: string, result: TaskResult): void {
		const slot = this.slots.get(taskId);
		if (!slot || slot.done) return;

		slot.done = true;
		slot.result = result;
		slot.activeActor = undefined;
		this.results.push(result);

		this.checkPolicy();
	}

	private onTaskFailed(taskId: string, error: string): void {
		const slot = this.slots.get(taskId);
		if (!slot || slot.done) return;

		slot.activeActor = undefined;

		if (slot.attemptCount < this.maxTaskAttempts) {
			this.spawnTask(slot);
		} else {
			slot.done = true;
			slot.result = { status: "failure", summary: error };
			this.results.push(slot.result);
			this.checkPolicy();
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
				policyMet = allDone && p.fn(this.results);
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

	private cancelRunning(): void {
		for (const [, slot] of this.slots) {
			if (slot.activeActor) {
				slot.activeActor.send({ type: "cancel" });
				slot.activeActor = undefined;
			}
		}
	}
}
