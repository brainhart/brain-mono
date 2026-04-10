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

export type StageState = {
	stageId: StageId;
	status: StageStatus;
	currentAttemptId?: StageAttemptId;
	attemptCount: number;
};

export type TaskState = {
	taskId: TaskId;
	status: TaskStatus;
	attemptCount: number;
	result?: TaskResult;
};

export type JobState = {
	jobId: JobId;
	status: JobStatus;
	stages: Map<StageId, StageState>;
	tasks: Map<TaskId, TaskState>;
	stageResults: Map<StageId, TaskResult[]>;
};

/**
 * Deterministic left-fold over the event log to rebuild in-memory state.
 */
export function projectState(events: readonly RuntimeEvent[]): JobState {
	let jobId = "";
	let status: JobStatus = "pending";
	const stages = new Map<StageId, StageState>();
	const tasks = new Map<TaskId, TaskState>();
	const stageResults = new Map<StageId, TaskResult[]>();

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
				break;

			case "job_paused":
				status = "paused";
				break;

			case "stage_submitted": {
				const ss = stages.get(event.stageId);
				if (ss) ss.status = "running";
				break;
			}

			case "stage_completed": {
				const ss = stages.get(event.stageId);
				if (ss) ss.status = "completed";
				break;
			}

			case "stage_failed": {
				const ss = stages.get(event.stageId);
				if (ss) ss.status = "failed";
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

			case "task_started": {
				const ts = tasks.get(event.taskId);
				if (ts) {
					ts.status = "running";
					ts.attemptCount = event.attemptNumber;
				} else {
					tasks.set(event.taskId, {
						taskId: event.taskId,
						status: "running",
						attemptCount: event.attemptNumber,
					});
				}
				break;
			}

			case "task_completed": {
				const ts = tasks.get(event.taskId);
				if (ts) {
					ts.status = "completed";
					ts.result = event.result;
				}
				break;
			}

			case "task_failed": {
				const ts = tasks.get(event.taskId);
				if (ts) {
					ts.status = "failed";
				}
				break;
			}

			default:
				break;
		}
	}

	return { jobId, status, stages, tasks, stageResults };
}
