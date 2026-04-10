export type JobId = string;
export type StageId = string;
export type StageAttemptId = string;
export type TaskId = string;
export type TaskAttemptId = string;
export type SessionId = string;

export type TaskResult = {
	status: "success" | "failure" | "blocked";
	summary: string;
	artifacts?: string[];
	signals?: Record<string, unknown>;
	metrics?: Record<string, number>;
};

export type TaskDefinition = {
	id: TaskId;
	prompt: string;
	context?: Record<string, unknown>;
	config?: Record<string, unknown>;
};

export type CompletionPolicy =
	| { type: "all" }
	| { type: "quorum"; n: number }
	| { type: "first_success" }
	| { type: "predicate"; fn: (results: TaskResult[]) => boolean };

/**
 * The batch of tasks for a single stage attempt (Spark's TaskSet).
 */
export type TaskSet = {
	stageId: StageId;
	stageAttemptId: StageAttemptId;
	tasks: TaskDefinition[];
};

export interface DAGMutator {
	addStage(stage: StageDefinition): void;
	addDependency(
		parentId: StageId,
		childId: StageId,
		transition?: TransitionFn,
	): void;
	getStage(id: StageId): StageDefinition | undefined;
	getStageIds(): StageId[];
	/**
	 * Move a completed stage back to waiting so it can be re-executed.
	 * Used for review loops: `implement → review → [transition] → remediate → review`.
	 */
	resetStage(stageId: StageId): void;
	/**
	 * Signal that the job should pause pending external input.
	 * The scheduler will stop scheduling new stages.
	 */
	pause(): void;
}

export type TransitionFn = (
	parentResults: TaskResult[],
	dag: DAGMutator,
) => void | Promise<void>;

export type StageDefinition = {
	id: StageId;
	name: string;
	tasks: TaskDefinition[];
	completionPolicy?: CompletionPolicy;
	maxStageAttempts?: number;
	maxTaskAttempts?: number;
};

export type StageDependency = {
	parentStageId: StageId;
	childStageId: StageId;
	transition?: TransitionFn;
};

export type JobDefinition = {
	id?: JobId;
	stages: StageDefinition[];
	dependencies: StageDependency[];
};

export type StageStatus =
	| "waiting"
	| "running"
	| "completed"
	| "failed"
	| "skipped";
export type JobStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "paused";
export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type JobResult = {
	jobId: JobId;
	status: "completed" | "failed";
	stageResults: Map<StageId, TaskResult[]>;
	error?: string;
};

export type TaskExecutor = (
	task: TaskDefinition,
	sessionId: SessionId,
) => Promise<TaskResult>;

/**
 * Snapshot of the scheduler's view of a stage at a point in time.
 */
export type StageInfo = {
	stageId: StageId;
	status: StageStatus;
	attemptCount: number;
	results?: TaskResult[];
};

/**
 * Snapshot of a running or completed job.
 */
export type JobSnapshot = {
	jobId: JobId;
	status: JobStatus;
	stages: StageInfo[];
	stageResults: Map<StageId, TaskResult[]>;
};
