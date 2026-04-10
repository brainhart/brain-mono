import type {
	JobId,
	StageId,
	StageAttemptId,
	TaskId,
	TaskAttemptId,
	SessionId,
	TaskResult,
} from "./types.js";

type BaseEvent = {
	jobId: JobId;
	timestamp: number;
	/** Monotonic sequence number assigned by EventLog.append(). */
	seq?: number;
};

export type JobSubmittedEvent = BaseEvent & {
	type: "job_submitted";
	stageIds: StageId[];
};

export type JobCompletedEvent = BaseEvent & {
	type: "job_completed";
};

export type JobFailedEvent = BaseEvent & {
	type: "job_failed";
	error: string;
};

export type JobPausedEvent = BaseEvent & {
	type: "job_paused";
};

export type JobResumedEvent = BaseEvent & {
	type: "job_resumed";
};

export type StageSubmittedEvent = BaseEvent & {
	type: "stage_submitted";
	stageId: StageId;
};

export type StageCompletedEvent = BaseEvent & {
	type: "stage_completed";
	stageId: StageId;
};

export type StageFailedEvent = BaseEvent & {
	type: "stage_failed";
	stageId: StageId;
	error: string;
};

export type StageResetEvent = BaseEvent & {
	type: "stage_reset";
	stageId: StageId;
};

export type StageAttemptStartedEvent = BaseEvent & {
	type: "stage_attempt_started";
	stageId: StageId;
	stageAttemptId: StageAttemptId;
	attemptNumber: number;
};

export type StageAttemptCompletedEvent = BaseEvent & {
	type: "stage_attempt_completed";
	stageId: StageId;
	stageAttemptId: StageAttemptId;
};

export type StageAttemptFailedEvent = BaseEvent & {
	type: "stage_attempt_failed";
	stageId: StageId;
	stageAttemptId: StageAttemptId;
	error: string;
};

export type TaskStartedEvent = BaseEvent & {
	type: "task_started";
	stageId: StageId;
	taskId: TaskId;
	taskAttemptId: TaskAttemptId;
	stageAttemptId: StageAttemptId;
	attemptNumber: number;
};

export type TaskCompletedEvent = BaseEvent & {
	type: "task_completed";
	stageId: StageId;
	taskId: TaskId;
	taskAttemptId: TaskAttemptId;
	result: TaskResult;
};

export type TaskFailedEvent = BaseEvent & {
	type: "task_failed";
	stageId: StageId;
	taskId: TaskId;
	taskAttemptId: TaskAttemptId;
	error: string;
};

export type SessionAttachedEvent = BaseEvent & {
	type: "session_attached";
	taskAttemptId: TaskAttemptId;
	sessionId: SessionId;
};

export type TransitionEvaluatedEvent = BaseEvent & {
	type: "transition_evaluated";
	parentStageId: StageId;
	childStageId: StageId;
	addedStages: StageId[];
	resetStages: StageId[];
};

export type RuntimeEvent =
	| JobSubmittedEvent
	| JobCompletedEvent
	| JobFailedEvent
	| JobPausedEvent
	| JobResumedEvent
	| StageSubmittedEvent
	| StageCompletedEvent
	| StageFailedEvent
	| StageResetEvent
	| StageAttemptStartedEvent
	| StageAttemptCompletedEvent
	| StageAttemptFailedEvent
	| TaskStartedEvent
	| TaskCompletedEvent
	| TaskFailedEvent
	| SessionAttachedEvent
	| TransitionEvaluatedEvent;
