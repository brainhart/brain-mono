import type {
	StageId,
	StageAttemptId,
	TaskResult,
	StageDefinition,
	JobId,
} from "./types.js";
import { EventLog } from "./event-log.js";
import type { RuntimeEvent } from "./events.js";
import { MutableDAG } from "./dag.js";
import {
	TaskSetManager,
	type TaskSetOutcome,
} from "./task-set-manager.js";
import { TaskRunner } from "./task-runner.js";

export type StageInfo = {
	stageId: StageId;
	status: "waiting" | "running" | "completed" | "failed";
	attemptCount: number;
};

export type DAGSchedulerCallbacks = {
	onJobCompleted?: (results: Map<StageId, TaskResult[]>) => void;
	onJobFailed?: (error: string) => void;
};

/**
 * Central orchestrator. Maintains the stage DAG, submits stages in
 * dependency order, evaluates transition functions, and handles
 * stage-level retries.
 */
export class DAGScheduler {
	private readonly waitingStages = new Set<StageId>();
	private readonly runningStages = new Set<StageId>();
	private readonly completedStages = new Set<StageId>();
	private readonly failedStages = new Set<StageId>();

	private readonly stageAttemptCounters = new Map<StageId, number>();
	private readonly stageResults = new Map<StageId, TaskResult[]>();

	private resolveJob!: (results: Map<StageId, TaskResult[]>) => void;
	private rejectJob!: (error: Error) => void;
	private jobPromise: Promise<Map<StageId, TaskResult[]>>;

	constructor(
		private readonly jobId: JobId,
		private readonly dag: MutableDAG,
		private readonly runner: TaskRunner,
		private readonly log: EventLog,
		private readonly callbacks?: DAGSchedulerCallbacks,
	) {
		this.jobPromise = new Promise((resolve, reject) => {
			this.resolveJob = resolve;
			this.rejectJob = reject;
		});
	}

	/**
	 * Start scheduling. Finds root stages (no parents) and submits them.
	 */
	async start(): Promise<Map<StageId, TaskResult[]>> {
		for (const sid of this.dag.getStageIds()) {
			this.waitingStages.add(sid);
		}

		this.emit({
			type: "job_submitted",
			jobId: this.jobId,
			stageIds: this.dag.getStageIds(),
			timestamp: Date.now(),
		});

		this.scheduleReady();
		return this.jobPromise;
	}

	private scheduleReady(): void {
		const readyStages: StageId[] = [];

		for (const sid of this.waitingStages) {
			const parents = this.dag.getParentStageIds(sid);
			const allParentsCompleted = parents.every((pid) =>
				this.completedStages.has(pid),
			);
			if (allParentsCompleted) {
				readyStages.push(sid);
			}
		}

		for (const sid of readyStages) {
			this.waitingStages.delete(sid);
			this.runningStages.add(sid);
			this.submitStage(sid);
		}

		if (readyStages.length === 0 && this.runningStages.size === 0) {
			this.checkTermination();
		}
	}

	private submitStage(stageId: StageId): void {
		const stageDef = this.dag.getStage(stageId)!;
		const attemptNum = (this.stageAttemptCounters.get(stageId) ?? 0) + 1;
		this.stageAttemptCounters.set(stageId, attemptNum);
		const stageAttemptId: StageAttemptId = `${stageId}:attempt:${attemptNum}`;

		this.emit({
			type: "stage_submitted",
			jobId: this.jobId,
			stageId,
			timestamp: Date.now(),
		});

		this.emit({
			type: "stage_attempt_started",
			jobId: this.jobId,
			stageId,
			stageAttemptId,
			attemptNumber: attemptNum,
			timestamp: Date.now(),
		});

		const tsm = new TaskSetManager(
			stageId,
			stageAttemptId,
			this.jobId,
			stageDef.tasks,
			this.runner,
			{
				completionPolicy: stageDef.completionPolicy,
				maxTaskAttempts: stageDef.maxTaskAttempts,
			},
		);

		tsm.execute().then(
			(outcome) => this.handleStageOutcome(stageId, stageAttemptId, stageDef, outcome),
			(err) => this.handleStageError(stageId, stageAttemptId, stageDef, err),
		);
	}

	private async handleStageOutcome(
		stageId: StageId,
		stageAttemptId: StageAttemptId,
		stageDef: StageDefinition,
		outcome: TaskSetOutcome,
	): Promise<void> {
		if (outcome.status === "completed") {
			this.emit({
				type: "stage_attempt_completed",
				jobId: this.jobId,
				stageId,
				stageAttemptId,
				timestamp: Date.now(),
			});

			this.runningStages.delete(stageId);
			this.completedStages.add(stageId);
			this.stageResults.set(stageId, outcome.results);

			this.emit({
				type: "stage_completed",
				jobId: this.jobId,
				stageId,
				timestamp: Date.now(),
			});

			await this.evaluateTransitions(stageId, outcome.results);
			this.scheduleReady();
		} else {
			this.emit({
				type: "stage_attempt_failed",
				jobId: this.jobId,
				stageId,
				stageAttemptId,
				error: outcome.error,
				timestamp: Date.now(),
			});

			const maxAttempts = stageDef.maxStageAttempts ?? 1;
			const currentAttempts =
				this.stageAttemptCounters.get(stageId) ?? 1;

			if (currentAttempts < maxAttempts) {
				this.submitStage(stageId);
			} else {
				this.runningStages.delete(stageId);
				this.failedStages.add(stageId);

				this.emit({
					type: "stage_failed",
					jobId: this.jobId,
					stageId,
					error: outcome.error,
					timestamp: Date.now(),
				});

				this.failDependents(stageId);
				this.checkTermination();
			}
		}
	}

	private handleStageError(
		stageId: StageId,
		stageAttemptId: StageAttemptId,
		_stageDef: StageDefinition,
		err: unknown,
	): void {
		const msg = err instanceof Error ? err.message : String(err);

		this.emit({
			type: "stage_attempt_failed",
			jobId: this.jobId,
			stageId,
			stageAttemptId,
			error: msg,
			timestamp: Date.now(),
		});

		this.runningStages.delete(stageId);
		this.failedStages.add(stageId);

		this.emit({
			type: "stage_failed",
			jobId: this.jobId,
			stageId,
			error: msg,
			timestamp: Date.now(),
		});

		this.failDependents(stageId);
		this.checkTermination();
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
				const addedStages = afterIds.filter((id) => !beforeIds.has(id));

				for (const newId of addedStages) {
					this.waitingStages.add(newId);
				}

				this.emit({
					type: "transition_evaluated",
					jobId: this.jobId,
					parentStageId: dep.parentStageId,
					childStageId: dep.childStageId,
					addedStages,
					timestamp: Date.now(),
				});
			}
		}
	}

	private failDependents(stageId: StageId): void {
		const children = this.dag.getChildStageIds(stageId);
		for (const cid of children) {
			if (this.waitingStages.has(cid)) {
				this.waitingStages.delete(cid);
				this.failedStages.add(cid);
				this.emit({
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

		const allDone =
			this.completedStages.size + this.failedStages.size ===
			this.dag.size;

		if (!allDone) return;

		if (this.failedStages.size > 0) {
			const failedIds = [...this.failedStages].join(", ");
			const error = `Job failed: stages [${failedIds}] failed`;
			this.emit({
				type: "job_failed",
				jobId: this.jobId,
				error,
				timestamp: Date.now(),
			});
			this.callbacks?.onJobFailed?.(error);
			this.rejectJob(new Error(error));
		} else {
			this.emit({
				type: "job_completed",
				jobId: this.jobId,
				timestamp: Date.now(),
			});
			this.callbacks?.onJobCompleted?.(this.stageResults);
			this.resolveJob(this.stageResults);
		}
	}

	private emit(event: RuntimeEvent): void {
		this.log.append(event);
	}

	getStageInfo(): StageInfo[] {
		const info: StageInfo[] = [];
		for (const sid of this.dag.getStageIds()) {
			let status: StageInfo["status"] = "waiting";
			if (this.completedStages.has(sid)) status = "completed";
			else if (this.failedStages.has(sid)) status = "failed";
			else if (this.runningStages.has(sid)) status = "running";
			info.push({
				stageId: sid,
				status,
				attemptCount: this.stageAttemptCounters.get(sid) ?? 0,
			});
		}
		return info;
	}
}
