import { Actor, Deferred } from "./actor.js";
import type { ActorRef } from "./actor.js";
import type {
	StageId,
	StageAttemptId,
	TaskResult,
	JobId,
	TaskExecutor,
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
	| { type: "start" }
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
	| { type: "resume" }
	| { type: "cancel" };

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
	private jobStatus: JobStatus = "pending";
	readonly completion: Deferred<Map<StageId, TaskResult[]>>;

	constructor(
		private readonly jobId: JobId,
		private readonly dag: MutableDAG,
		private readonly executor: TaskExecutor,
		private readonly pool: ActorRef<SessionPoolMsg>,
		private readonly log: EventLog,
	) {
		super();
		this.completion = new Deferred();
	}

	protected async handle(msg: DAGSchedulerActorMsg): Promise<void> {
		if (this.terminated) return;

		switch (msg.type) {
			case "start":
				this.onStart();
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
			case "resume":
				this.onResume();
				break;
			case "cancel":
				this.onCancel();
				break;
		}
	}

	private onStart(): void {
		this.jobStatus = "running";
		for (const sid of this.dag.getStageIds()) {
			this.waitingStages.add(sid);
		}

		this.log.append({
			type: "job_submitted",
			jobId: this.jobId,
			stageIds: this.dag.getStageIds(),
			timestamp: Date.now(),
		});

		this.scheduleReady();
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
		const stageDef = this.dag.getStage(stageId)!;
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

		await this.evaluateTransitions(stageId, results);
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

		const stageDef = this.dag.getStage(stageId)!;
		const maxAttempts = stageDef.maxStageAttempts ?? 1;
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
					this.completedStages.delete(rid);
					this.failedStages.delete(rid);
					this.waitingStages.add(rid);
					this.log.append({
						type: "stage_reset",
						jobId: this.jobId,
						stageId: rid,
						timestamp: Date.now(),
					});
				}

				const shouldPause = this.dag.consumePauseRequest();

				this.log.append({
					type: "transition_evaluated",
					jobId: this.jobId,
					parentStageId: dep.parentStageId,
					childStageId: dep.childStageId,
					addedStages,
					resetStages,
					timestamp: Date.now(),
				});

				if (shouldPause) {
					this.paused = true;
					this.jobStatus = "paused";
					this.log.append({
						type: "job_paused",
						jobId: this.jobId,
						timestamp: Date.now(),
					});
				}
			}
		}
	}

	private onResume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.jobStatus = "running";
		this.log.append({
			type: "job_resumed",
			jobId: this.jobId,
			timestamp: Date.now(),
		});
		this.scheduleReady();
	}

	private failDependents(stageId: StageId): void {
		for (const cid of this.dag.getChildStageIds(stageId)) {
			if (this.waitingStages.has(cid)) {
				this.waitingStages.delete(cid);
				this.failedStages.add(cid);
				this.log.append({
					type: "stage_failed",
					jobId: this.jobId,
					stageId: cid,
					error: `Parent stage "${stageId}" failed`,
					timestamp: Date.now(),
				});
				this.failDependents(cid);
			}
		}
	}

	private checkTermination(): void {
		if (this.runningStages.size > 0) return;
		if (this.waitingStages.size > 0) return;
		if (this.paused) return;

		if (this.terminated) return;
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
		for (const [, actor] of this.activeStageActors) {
			actor.send({ type: "cancel" });
		}
		this.activeStageActors.clear();
		this.stop();

		this.log.append({
			type: "job_failed",
			jobId: this.jobId,
			error: "Job cancelled",
			timestamp: Date.now(),
		});
		this.completion.reject(new Error("Job cancelled"));
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
