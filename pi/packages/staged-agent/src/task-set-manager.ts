import type {
	TaskDefinition,
	TaskResult,
	CompletionPolicy,
	StageId,
	StageAttemptId,
	TaskAttemptId,
} from "./types.js";
import { TaskRunner, type TaskRunnerOpts } from "./task-runner.js";

export type TaskSetOutcome =
	| { status: "completed"; results: TaskResult[] }
	| { status: "failed"; error: string; results: TaskResult[] };

/**
 * Manages one stage-attempt's worth of tasks.
 *
 * Dispatches tasks to a TaskRunner, applies the completion policy, and
 * handles task-level retries.
 */
export class TaskSetManager {
	private readonly completionPolicy: CompletionPolicy;
	private readonly maxTaskAttempts: number;

	constructor(
		private readonly stageId: StageId,
		private readonly stageAttemptId: StageAttemptId,
		private readonly jobId: string,
		private readonly tasks: TaskDefinition[],
		private readonly runner: TaskRunner,
		opts?: { completionPolicy?: CompletionPolicy; maxTaskAttempts?: number },
	) {
		this.completionPolicy = opts?.completionPolicy ?? { type: "all" };
		this.maxTaskAttempts = opts?.maxTaskAttempts ?? 3;
	}

	async execute(): Promise<TaskSetOutcome> {
		const results: TaskResult[] = [];
		const failures: string[] = [];

		const runTask = async (
			task: TaskDefinition,
		): Promise<TaskResult | null> => {
			let lastError: string | undefined;
			for (let attempt = 1; attempt <= this.maxTaskAttempts; attempt++) {
				const taskAttemptId: TaskAttemptId =
					`${task.id}:${this.stageAttemptId}:${attempt}`;
				const opts: TaskRunnerOpts = {
					jobId: this.jobId,
					stageAttemptId: this.stageAttemptId,
					taskId: task.id,
					attemptNumber: attempt,
					taskAttemptId,
				};
				try {
					return await this.runner.run(task, opts);
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
				}
			}
			failures.push(
				`Task ${task.id} failed after ${this.maxTaskAttempts} attempts: ${lastError}`,
			);
			return null;
		};

		const taskPromises = this.tasks.map(async (task) => {
			const result = await runTask(task);
			if (result) results.push(result);
		});

		await Promise.all(taskPromises);

		if (this.policyMet(results)) {
			return { status: "completed", results };
		}

		return {
			status: "failed",
			error: failures.join("; ") || "Completion policy not satisfied",
			results,
		};
	}

	private policyMet(results: TaskResult[]): boolean {
		const successful = results.filter((r) => r.status === "success");
		const p = this.completionPolicy;

		switch (p.type) {
			case "all":
				return (
					successful.length === this.tasks.length &&
					results.length === this.tasks.length
				);
			case "quorum":
				return successful.length >= p.n;
			case "first_success":
				return successful.length >= 1;
			case "predicate":
				return p.fn(results);
		}
	}
}
