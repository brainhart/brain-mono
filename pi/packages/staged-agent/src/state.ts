import type { RuntimeEvent } from "./events.js";
import type {
	JobId,
	JobStatus,
	StageId,
	StageStatus,
	TaskId,
	TaskStatus,
	TaskResult,
	TaskProgress,
	StageAttemptId,
	TaskOperatorNote,
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
	sessionFile?: string;
	sessionCwd?: string;
	error?: string;
	attempts: TaskAttemptRecord[];
	/** Most recent streaming progress lines (ring buffer, last N). */
	progressLines: string[];
	/** Raw structured progress entries for rich rendering. */
	progressEntries: TaskProgress[];
	operatorNotes: TaskOperatorNote[];
};

export type TransitionRecord = {
	parentStageId: StageId;
	childStageId: StageId;
	addedStages: StageId[];
	resetStages: StageId[];
	timestamp: number;
};

export type TokenUsage = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
};

export type JobState = {
	jobId: JobId;
	status: JobStatus;
	stages: Map<StageId, StageState>;
	tasks: Map<TaskId, TaskState>;
	stageResults: Map<StageId, TaskResult[]>;
	transitions: TransitionRecord[];
	error?: string;
	pauseReason?: string;
	lastResumeInput?: string;
	tokenUsage: TokenUsage;
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
	let pauseReason: string | undefined;
	let lastResumeInput: string | undefined;
	const stages = new Map<StageId, StageState>();
	const tasks = new Map<TaskId, TaskState>();
	const stageResults = new Map<StageId, TaskResult[]>();
	const transitions: TransitionRecord[] = [];
	const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

	const sessionMap = new Map<string, string>();
	const PROGRESS_RING_SIZE = 50;

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
				pauseReason = event.reason;
				break;

			case "job_resumed":
				status = "running";
				lastResumeInput = event.input;
				pauseReason = undefined;
				break;

			case "job_idle":
				status = "idle";
				break;

			case "job_finished":
				break;

			case "stages_added": {
				for (const sid of event.stageIds) {
					if (!stages.has(sid)) {
						stages.set(sid, {
							stageId: sid,
							status: "waiting",
							attemptCount: 0,
						});
					}
				}
				if (status === "idle") status = "running";
				break;
			}

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
					existing.sessionFile = undefined;
					existing.sessionCwd = undefined;
					existing.progressLines = [];
					existing.progressEntries = [];
					existing.attempts.push(attemptRec);
				} else {
					tasks.set(event.taskId, {
						taskId: event.taskId,
						stageId: event.stageId,
						status: "running",
						attemptCount: event.attemptNumber,
						startedAt: event.timestamp,
						sessionId: sessionMap.get(event.taskAttemptId),
						sessionFile: undefined,
						sessionCwd: undefined,
						attempts: [attemptRec],
						progressLines: [],
						progressEntries: [],
						operatorNotes: [],
					});
				}
				break;
			}

			case "task_progress": {
				const ts = tasks.get(event.taskId);
				if (ts) {
					let line: string;
					const p = event.progress;
					if (typeof p.signals?.sessionFile === "string") {
						ts.sessionFile = p.signals.sessionFile;
					}
					if (typeof p.signals?.sessionCwd === "string") {
						ts.sessionCwd = p.signals.sessionCwd;
					}
					if (p.kind === "text" && p.text) line = p.text;
					else if (p.kind === "tool_call") line = `⚡ ${p.toolName ?? "tool"}(${JSON.stringify(p.toolArgs ?? {}).slice(0, 80)})`;
					else if (p.kind === "tool_result" && p.text) line = `  → ${p.text}`;
					else if (p.kind === "status" && p.text) line = `⏳ ${p.text}`;
					else line = `[${p.kind}]`;

					ts.progressLines.push(line);
					if (ts.progressLines.length > PROGRESS_RING_SIZE) {
						ts.progressLines.splice(0, ts.progressLines.length - PROGRESS_RING_SIZE);
					}
					ts.progressEntries.push(event.progress);
					if (ts.progressEntries.length > PROGRESS_RING_SIZE) {
						ts.progressEntries.splice(0, ts.progressEntries.length - PROGRESS_RING_SIZE);
					}
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

				if (event.result.signals?.usage && typeof event.result.signals.usage === "object") {
					const u = event.result.signals.usage as Record<string, unknown>;
					const inp = Number(u.inputTokens ?? u.input_tokens ?? 0) || 0;
					const out = Number(u.outputTokens ?? u.output_tokens ?? 0) || 0;
					const tot = Number(u.totalTokens ?? u.total_tokens ?? 0) || (inp + out);
					tokenUsage.inputTokens += inp;
					tokenUsage.outputTokens += out;
					tokenUsage.totalTokens += tot;
				}
				break;
			}

			case "task_operator_note": {
				const ts = tasks.get(event.taskId);
				if (ts) {
					ts.operatorNotes.push({
						note: event.note,
						action: event.action,
						timestamp: event.timestamp,
					});
				}
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

	return { jobId, status, stages, tasks, stageResults, transitions, error: jobError, pauseReason, lastResumeInput, tokenUsage };
}
