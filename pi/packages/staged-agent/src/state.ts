import type { RuntimeEvent } from "./events.js";
import type {
	JobId,
	JobStatus,
	StageId,
	StageStatus,
	TaskId,
	TaskStatus,
	TaskResult,
	StageAttemptId,
} from "./types.js";

export type TaskAttemptRecord = {
	taskAttemptId: string;
	attemptNumber: number;
	startedAt: number;
	finishedAt?: number;
	sessionId?: string;
	result?: TaskResult;
	error?: string;
};

export type StageState = {
	stageId: StageId;
	status: StageStatus;
	currentAttemptId?: StageAttemptId;
	attemptCount: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
};

export type TaskState = {
	taskId: TaskId;
	stageId?: StageId;
	status: TaskStatus;
	attemptCount: number;
	result?: TaskResult;
	startedAt?: number;
	completedAt?: number;
	sessionId?: string;
	error?: string;
	attempts: TaskAttemptRecord[];
};

export type TransitionRecord = {
	parentStageId: StageId;
	childStageId: StageId;
	addedStages: StageId[];
	resetStages: StageId[];
	timestamp: number;
};

export type JobState = {
	jobId: JobId;
	status: JobStatus;
	stages: Map<StageId, StageState>;
	tasks: Map<TaskId, TaskState>;
	stageResults: Map<StageId, TaskResult[]>;
	transitions: TransitionRecord[];
	error?: string;
};

/**
 * Deterministic left-fold over the event log to rebuild in-memory state.
 *
 * Handles dynamically-added stages (via `transition_evaluated`),
 * stage resets (via `stage_reset`), pause/resume, and populates
 * `stageResults` from `task_completed` events.
 */
export function projectState(events: readonly RuntimeEvent[]): JobState {
	let jobId = "";
	let status: JobStatus = "pending";
	let jobError: string | undefined;
	const stages = new Map<StageId, StageState>();
	const tasks = new Map<TaskId, TaskState>();
	const stageResults = new Map<StageId, TaskResult[]>();
	const transitions: TransitionRecord[] = [];

	const sessionMap = new Map<string, string>();

	for (const event of events) {
		if (!jobId) jobId = event.jobId;

		switch (event.type) {
			case "job_submitted":
				status = "running";
				for (const sid of event.stageIds) {
					stages.set(sid, {
						stageId: sid,
						status: "waiting",
						attemptCount: 0,
					});
				}
				break;

			case "job_completed":
				status = "completed";
				break;

			case "job_failed":
				status = "failed";
				jobError = event.error;
				break;

			case "job_paused":
				status = "paused";
				break;

			case "job_resumed":
				status = "running";
				break;

			case "stage_submitted": {
				const ss = stages.get(event.stageId);
				if (ss) {
					ss.status = "running";
					ss.startedAt = ss.startedAt ?? event.timestamp;
				}
				break;
			}

			case "stage_completed": {
				const ss = stages.get(event.stageId);
				if (ss) {
					ss.status = "completed";
					ss.completedAt = event.timestamp;
				}
				break;
			}

			case "stage_failed": {
				const ss = stages.get(event.stageId);
				if (ss) {
					ss.status = "failed";
					ss.completedAt = event.timestamp;
					ss.error = event.error;
				}
				break;
			}

			case "stage_reset": {
				const ss = stages.get(event.stageId);
				if (ss) {
					ss.status = "waiting";
					ss.startedAt = undefined;
					ss.completedAt = undefined;
					ss.error = undefined;
				}
				stageResults.delete(event.stageId);
				break;
			}

			case "stage_attempt_started": {
				const ss = stages.get(event.stageId);
				if (ss) {
					ss.currentAttemptId = event.stageAttemptId;
					ss.attemptCount = event.attemptNumber;
				}
				break;
			}

			case "transition_evaluated": {
				for (const sid of event.addedStages) {
					if (!stages.has(sid)) {
						stages.set(sid, {
							stageId: sid,
							status: "waiting",
							attemptCount: 0,
						});
					}
				}
				transitions.push({
					parentStageId: event.parentStageId,
					childStageId: event.childStageId,
					addedStages: event.addedStages,
					resetStages: event.resetStages,
					timestamp: event.timestamp,
				});
				break;
			}

			case "session_attached": {
				sessionMap.set(event.taskAttemptId, event.sessionId);
				break;
			}

			case "task_started": {
				const attemptRec: TaskAttemptRecord = {
					taskAttemptId: event.taskAttemptId,
					attemptNumber: event.attemptNumber,
					startedAt: event.timestamp,
					sessionId: sessionMap.get(event.taskAttemptId),
				};

				const existing = tasks.get(event.taskId);
				if (existing) {
					existing.status = "running";
					existing.attemptCount = event.attemptNumber;
					existing.stageId = event.stageId;
					existing.startedAt = event.timestamp;
					existing.completedAt = undefined;
					existing.error = undefined;
					existing.sessionId = sessionMap.get(event.taskAttemptId);
					existing.attempts.push(attemptRec);
				} else {
					tasks.set(event.taskId, {
						taskId: event.taskId,
						stageId: event.stageId,
						status: "running",
						attemptCount: event.attemptNumber,
						startedAt: event.timestamp,
						sessionId: sessionMap.get(event.taskAttemptId),
						attempts: [attemptRec],
					});
				}
				break;
			}

			case "task_completed": {
				const ts = tasks.get(event.taskId);
				if (ts) {
					ts.status = "completed";
					ts.result = event.result;
					ts.completedAt = event.timestamp;

					const lastAttempt = ts.attempts[ts.attempts.length - 1];
					if (lastAttempt) {
						lastAttempt.finishedAt = event.timestamp;
						lastAttempt.result = event.result;
					}
				}

				const sid = event.stageId;
				if (!stageResults.has(sid)) {
					stageResults.set(sid, []);
				}
				stageResults.get(sid)!.push(event.result);
				break;
			}

			case "task_failed": {
				const ts = tasks.get(event.taskId);
				if (ts) {
					ts.status = "failed";
					ts.error = event.error;
					ts.completedAt = event.timestamp;

					const lastAttempt = ts.attempts[ts.attempts.length - 1];
					if (lastAttempt) {
						lastAttempt.finishedAt = event.timestamp;
						lastAttempt.error = event.error;
					}
				}
				break;
			}

			default:
				break;
		}
	}

	return { jobId, status, stages, tasks, stageResults, transitions, error: jobError };
}
