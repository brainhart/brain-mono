import { Actor, Deferred } from "./actor.js";
import type { ActorRef } from "./actor.js";
import type {
	StageId,
	StageAttemptId,
	TaskResult,
	JobId,
	StreamingTaskExecutor,
	JobStatus,
	JobSnapshot,
	StageInfo,
	StageStatus,
} from "./types.js";
import type { EventLog } from "./event-log.js";
import { MutableDAG } from "./dag.js";
import type { SessionPoolMsg } from "./session-pool-actor.js";
import { StageActor } from "./stage-actor.js";

export type DAGSchedulerActorMsg =
	| { type: "start"; recovery?: boolean }
	| {
			type: "stage_completed";
			stageId: StageId;
			stageAttemptId: StageAttemptId;
			results: TaskResult[];
	  }
	| {
			type: "stage_failed";
			stageId: StageId;
			stageAttemptId: StageAttemptId;
			error: string;
			results: TaskResult[];
	  }
	| { type: "pause"; reason?: string }
	| { type: "resume"; input?: string }
	| { type: "cancel" }
	| { type: "cancel_task"; taskId: string; stageId: StageId }
	| {
			type: "task_operator_note";
			taskId: string;
			stageId: StageId;
			note: string;
			action: import("./types.js").TaskOperatorAction;
	  }
	| {
			type: "retry_task_with_note";
			taskId: string;
			stageId: StageId;
			note: string;
	  }
	| {
			type: "add_stages";
			stages: import("./types.js").StageDefinition[];
			dependencies: import("./types.js").StageDependency[];
	  }
	| { type: "finish" };

/**
 * Central orchestrator actor.
 *
 * Maintains the stage DAG, submits stages in dependency order, evaluates
 * transition functions, handles stage-level retries, pause/resume, and
 * stage re-entry for review loops. All state mutations happen inside the
 * serialised message handler.
 */
export class DAGSchedulerActor extends Actor<DAGSchedulerActorMsg> {
	private readonly waitingStages = new Set<StageId>();
	private readonly runningStages = new Set<StageId>();
	private readonly completedStages = new Set<StageId>();
	private readonly failedStages = new Set<StageId>();

	private readonly stageAttemptCounters = new Map<StageId, number>();
	private readonly stageResults = new Map<StageId, TaskResult[]>();
	private readonly activeStageActors = new Map<StageId, StageActor>();

	private terminated = false;
	private paused = false;
	private finishRequested = false;
	private jobStatus: JobStatus = "pending";
	private readonly interactive: boolean;
	readonly completion: Deferred<Map<StageId, TaskResult[]>>;

	constructor(
		private readonly jobId: JobId,
		private readonly dag: MutableDAG,
		private readonly executor: StreamingTaskExecutor,
		private readonly pool: ActorRef<SessionPoolMsg>,
		private readonly log: EventLog,
		opts?: { interactive?: boolean },
	) {
		super();
		this.completion = new Deferred();
		this.interactive = opts?.interactive ?? false;
	}

	protected async handle(msg: DAGSchedulerActorMsg): Promise<void> {
		if (this.terminated) return;

		switch (msg.type) {
			case "start":
				this.beginJob(msg.recovery ?? false);
				break;
			case "stage_completed":
				await this.onStageCompleted(
					msg.stageId,
					msg.stageAttemptId,
					msg.results,
				);
				break;
			case "stage_failed":
				this.onStageFailed(
					msg.stageId,
					msg.stageAttemptId,
					msg.error,
					msg.results,
				);
				break;
			case "pause":
				this.onPause(msg.reason);
				break;
			case "resume":
				this.onResume(msg.input);
				break;
			case "cancel":
				this.onCancel();
				break;
			case "cancel_task":
				this.onCancelTask(msg.taskId, msg.stageId);
				break;
			case "task_operator_note":
				this.onTaskOperatorNote(msg.taskId, msg.stageId, msg.note, msg.action);
				break;
			case "retry_task_with_note":
				this.onRetryTaskWithNote(msg.taskId, msg.stageId, msg.note);
				break;
			case "add_stages":
				this.onAddStages(msg.stages, msg.dependencies);
				break;
			case "finish":
				this.onFinish();
				break;
		}
	}

	private beginJob(recovery: boolean): void {
		const stageIds = this.dag.getStageIds();
		const hasWork = stageIds.length > 0;

		this.jobStatus = hasWork ? "running" : (this.interactive ? "idle" : "running");
		for (const sid of stageIds) {
			this.waitingStages.add(sid);
		}

		if (recovery) {
			this.log.append({
				type: "job_resumed",
				jobId: this.jobId,
				timestamp: Date.now(),
			});
		} else {
			this.log.append({
				type: "job_submitted",
				jobId: this.jobId,
				stageIds,
				timestamp: Date.now(),
			});
		}

		if (hasWork) {
			this.scheduleReady();
		} else if (this.interactive) {
			this.log.append({
				type: "job_idle",
				jobId: this.jobId,
				timestamp: Date.now(),
			});
		} else {
			this.scheduleReady();
		}
	}

	private scheduleReady(): void {
		if (this.paused) return;

		const ready: StageId[] = [];

		for (const sid of this.waitingStages) {
			const parents = this.dag.getParentStageIds(sid);
			if (parents.every((pid) => this.completedStages.has(pid))) {
				ready.push(sid);
			}
		}

		for (const sid of ready) {
			this.waitingStages.delete(sid);
			this.runningStages.add(sid);
			this.submitStage(sid);
		}

		if (ready.length === 0 && this.runningStages.size === 0) {
			this.checkTermination();
		}
	}

	private submitStage(stageId: StageId): void {
		const stageDef = this.dag.getStage(stageId);
		if (!stageDef) {
			this.log.append({
				type: "stage_failed",
				jobId: this.jobId,
				stageId,
				error: `Stage "${stageId}" not found in DAG`,
				timestamp: Date.now(),
			});
			this.runningStages.delete(stageId);
			this.failedStages.add(stageId);
			this.checkTermination();
			return;
		}
		const attemptNum =
			(this.stageAttemptCounters.get(stageId) ?? 0) + 1;
		this.stageAttemptCounters.set(stageId, attemptNum);
		const stageAttemptId: StageAttemptId =
			`${stageId}:attempt:${attemptNum}`;

		this.log.append({
			type: "stage_submitted",
			jobId: this.jobId,
			stageId,
			timestamp: Date.now(),
		});

		this.log.append({
			type: "stage_attempt_started",
			jobId: this.jobId,
			stageId,
			stageAttemptId,
			attemptNumber: attemptNum,
			timestamp: Date.now(),
		});

		const actor = new StageActor(
			stageId,
			stageAttemptId,
			this.jobId,
			stageDef.tasks,
			this.executor,
			this.pool,
			this.ref(),
			this.log,
			{
				completionPolicy: stageDef.completionPolicy,
				maxTaskAttempts: stageDef.maxTaskAttempts,
				taskTimeoutMs: stageDef.taskTimeoutMs,
				acquireTimeoutMs: stageDef.acquireTimeoutMs,
			},
		);

		this.activeStageActors.set(stageId, actor);
		actor.send({ type: "run" });
	}

	private async onStageCompleted(
		stageId: StageId,
		stageAttemptId: StageAttemptId,
		results: TaskResult[],
	): Promise<void> {
		this.activeStageActors.delete(stageId);

		this.log.append({
			type: "stage_attempt_completed",
			jobId: this.jobId,
			stageId,
			stageAttemptId,
			timestamp: Date.now(),
		});

		this.runningStages.delete(stageId);
		this.completedStages.add(stageId);
		this.stageResults.set(stageId, results);

		this.log.append({
			type: "stage_completed",
			jobId: this.jobId,
			stageId,
			timestamp: Date.now(),
		});

		try {
			await this.evaluateTransitions(stageId, results);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (this.interactive) {
				this.log.append({
					type: "stage_failed",
					jobId: this.jobId,
					stageId,
					error: `Transition function failed: ${msg}`,
					timestamp: Date.now(),
				});
				this.scheduleReady();
				return;
			}
			this.log.append({
				type: "job_failed",
				jobId: this.jobId,
				error: `Transition function failed: ${msg}`,
				timestamp: Date.now(),
			});
			this.cancelActiveActors();
			this.terminated = true;
			this.jobStatus = "failed";
			this.stop();
			this.completion.reject(
				new Error(`Transition function failed: ${msg}`),
			);
			return;
		}
		this.scheduleReady();
	}

	private onStageFailed(
		stageId: StageId,
		stageAttemptId: StageAttemptId,
		error: string,
		_results: TaskResult[],
	): void {
		this.activeStageActors.delete(stageId);

		this.log.append({
			type: "stage_attempt_failed",
			jobId: this.jobId,
			stageId,
			stageAttemptId,
			error,
			timestamp: Date.now(),
		});

		const stageDef = this.dag.getStage(stageId);
		const maxAttempts = stageDef?.maxStageAttempts ?? 1;
		const currentAttempts =
			this.stageAttemptCounters.get(stageId) ?? 1;

		if (currentAttempts < maxAttempts) {
			this.submitStage(stageId);
		} else {
			this.runningStages.delete(stageId);
			this.failedStages.add(stageId);

			this.log.append({
				type: "stage_failed",
				jobId: this.jobId,
				stageId,
				error,
				timestamp: Date.now(),
			});

			this.failDependents(stageId);
			this.checkTermination();
		}
	}

	private async evaluateTransitions(
		stageId: StageId,
		results: TaskResult[],
	): Promise<void> {
		const childDeps = this.dag.getChildDependencies(stageId);
		for (const dep of childDeps) {
			if (dep.transition) {
				const beforeIds = new Set(this.dag.getStageIds());
				await dep.transition(results, this.dag);
				const afterIds = this.dag.getStageIds();
				const addedStages = afterIds.filter(
					(id) => !beforeIds.has(id),
				);

				for (const newId of addedStages) {
					this.waitingStages.add(newId);
				}

				const resetStages = this.dag.consumeResetRequests();
				for (const rid of resetStages) {
					if (this.runningStages.has(rid)) continue;
					this.completedStages.delete(rid);
					this.failedStages.delete(rid);
					this.stageAttemptCounters.delete(rid);
					this.waitingStages.add(rid);
					this.log.append({
						type: "stage_reset",
						jobId: this.jobId,
						stageId: rid,
						timestamp: Date.now(),
					});
				}

				const pauseReq = this.dag.consumePauseRequest();

				this.log.append({
					type: "transition_evaluated",
					jobId: this.jobId,
					parentStageId: dep.parentStageId,
					childStageId: dep.childStageId,
					addedStages,
					resetStages,
					timestamp: Date.now(),
				});

				if (pauseReq.paused) {
					this.paused = true;
					this.jobStatus = "paused";
					this.log.append({
						type: "job_paused",
						jobId: this.jobId,
						reason: pauseReq.reason,
						timestamp: Date.now(),
					});
				}
			}
		}
	}

	private onPause(reason?: string): void {
		if (this.paused || this.terminated) return;
		this.paused = true;
		this.jobStatus = "paused";
		this.log.append({
			type: "job_paused",
			jobId: this.jobId,
			reason,
			timestamp: Date.now(),
		});
	}

	private onResume(input?: string): void {
		if (!this.paused) return;
		this.paused = false;
		this.jobStatus = "running";
		this.log.append({
			type: "job_resumed",
			jobId: this.jobId,
			input,
			timestamp: Date.now(),
		});
		this.scheduleReady();
	}

	private onCancelTask(taskId: string, stageId: StageId): void {
		const actor = this.activeStageActors.get(stageId);
		if (actor) {
			actor.send({ type: "cancel_task", taskId });
		}
	}

	private onTaskOperatorNote(
		taskId: string,
		stageId: StageId,
		note: string,
		action: import("./types.js").TaskOperatorAction,
	): void {
		const actor = this.activeStageActors.get(stageId);
		if (!actor) return;
		this.log.append({
			type: "task_operator_note",
			jobId: this.jobId,
			stageId,
			taskId,
			note,
			action,
			timestamp: Date.now(),
		});
		actor.send({ type: "task_operator_note", taskId, note, action });
	}

	private onRetryTaskWithNote(
		taskId: string,
		stageId: StageId,
		note: string,
	): void {
		const actor = this.activeStageActors.get(stageId);
		if (!actor) return;
		this.log.append({
			type: "task_operator_note",
			jobId: this.jobId,
			stageId,
			taskId,
			note,
			action: "retry",
			timestamp: Date.now(),
		});
		actor.send({ type: "retry_task_with_note", taskId, note });
	}

	private onAddStages(
		stages: import("./types.js").StageDefinition[],
		dependencies: import("./types.js").StageDependency[],
	): void {
		if (this.terminated) return;

		const addedIds: StageId[] = [];
		const depEdges: Array<{ parent: StageId; child: StageId }> = [];

		try {
			for (const stage of stages) {
				if (!this.dag.getStage(stage.id)) {
					this.dag.addStage(stage);
					this.waitingStages.add(stage.id);
					addedIds.push(stage.id);
				}
			}

			for (const dep of dependencies) {
				if (!this.dag.getDependency(dep.parentStageId, dep.childStageId)) {
					this.dag.addDependency(dep.parentStageId, dep.childStageId, dep.transition);
					depEdges.push({ parent: dep.parentStageId, child: dep.childStageId });
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.log.append({
				type: "stage_failed",
				jobId: this.jobId,
				stageId: addedIds[addedIds.length - 1] ?? "unknown",
				error: `Failed to add stages: ${msg}`,
				timestamp: Date.now(),
			});
			return;
		}

		if (addedIds.length > 0) {
			this.log.append({
				type: "stages_added",
				jobId: this.jobId,
				stageIds: addedIds,
				dependencyEdges: depEdges,
				timestamp: Date.now(),
			});
		}

		if (this.jobStatus === "idle") {
			this.jobStatus = "running";
		}

		this.scheduleReady();
	}

	private onFinish(): void {
		if (this.terminated) return;
		this.finishRequested = true;

		this.log.append({
			type: "job_finished",
			jobId: this.jobId,
			timestamp: Date.now(),
		});

		if (this.runningStages.size === 0 && this.waitingStages.size === 0) {
			this.checkTermination();
		}
	}

	private failDependents(rootStageId: StageId): void {
		const queue = [rootStageId];
		while (queue.length > 0) {
			const sid = queue.shift()!;
			for (const cid of this.dag.getChildStageIds(sid)) {
				if (this.waitingStages.has(cid)) {
					this.waitingStages.delete(cid);
					this.failedStages.add(cid);
					this.log.append({
						type: "stage_failed",
						jobId: this.jobId,
						stageId: cid,
						error: `Parent stage "${sid}" failed`,
						timestamp: Date.now(),
					});
					queue.push(cid);
				}
			}
		}
	}

	private checkTermination(): void {
		if (this.runningStages.size > 0) return;
		if (this.waitingStages.size > 0) return;
		if (this.paused) return;

		if (this.terminated) return;

		if (this.failedStages.size > 0 && !this.interactive) {
			this.terminated = true;
			const failedIds = [...this.failedStages].join(", ");
			const error = `Job failed: stages [${failedIds}] failed`;
			this.jobStatus = "failed";
			this.log.append({
				type: "job_failed",
				jobId: this.jobId,
				error,
				timestamp: Date.now(),
			});
			this.stop();
			this.completion.reject(new Error(error));
			return;
		}

		if (this.interactive && !this.finishRequested) {
			if (this.jobStatus !== "idle") {
				this.jobStatus = "idle";
				this.log.append({
					type: "job_idle",
					jobId: this.jobId,
					timestamp: Date.now(),
				});
			}
			return;
		}

		this.terminated = true;

		if (this.failedStages.size > 0) {
			const failedIds = [...this.failedStages].join(", ");
			const error = `Job failed: stages [${failedIds}] failed`;
			this.jobStatus = "failed";
			this.log.append({
				type: "job_failed",
				jobId: this.jobId,
				error,
				timestamp: Date.now(),
			});
			this.stop();
			this.completion.reject(new Error(error));
		} else {
			this.jobStatus = "completed";
			this.log.append({
				type: "job_completed",
				jobId: this.jobId,
				timestamp: Date.now(),
			});
			this.stop();
			this.completion.resolve(this.stageResults);
		}
	}

	private onCancel(): void {
		this.terminated = true;
		this.jobStatus = "failed";
		this.cancelActiveActors();
		this.stop();

		this.log.append({
			type: "job_failed",
			jobId: this.jobId,
			error: "Job cancelled",
			timestamp: Date.now(),
		});
		this.completion.reject(new Error("Job cancelled"));
	}

	private cancelActiveActors(): void {
		for (const [, actor] of this.activeStageActors) {
			actor.send({ type: "cancel" });
		}
		this.activeStageActors.clear();
	}

	// --- Inspection views (Gap #2) ---

	getStageResults(): Map<StageId, TaskResult[]> {
		return new Map(this.stageResults);
	}

	getJobStatus(): JobStatus {
		return this.jobStatus;
	}

	inspect(): JobSnapshot {
		const stages: StageInfo[] = [];
		for (const sid of this.dag.getStageIds()) {
			let status: StageStatus = "waiting";
			if (this.completedStages.has(sid)) status = "completed";
			else if (this.failedStages.has(sid)) status = "failed";
			else if (this.runningStages.has(sid)) status = "running";
			stages.push({
				stageId: sid,
				status,
				attemptCount: this.stageAttemptCounters.get(sid) ?? 0,
				results: this.stageResults.get(sid),
			});
		}
		return {
			jobId: this.jobId,
			status: this.jobStatus,
			stages,
			stageResults: new Map(this.stageResults),
		};
	}
}
