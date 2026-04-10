/**
 * Job profiles — reusable templates that generate stage structures from
 * a user's task description.
 *
 * Profiles sit between "start empty and submit one stage at a time" and
 * "pre-seed a fully hardcoded DAG." The user picks a profile (or gets a
 * default), describes what they want, and the profile generates an
 * appropriate set of stages and dependencies.
 *
 * Profiles can be static (fixed stage structure, only the prompt text
 * varies) or dynamic (a function that inspects the prompt and decides
 * how many stages, what transitions to use, etc.).
 */

import type { StageDefinition, StageDependency, TransitionFn, TaskResult, DAGMutator } from "./types.js";

export type ProfileStages = {
	stages: StageDefinition[];
	dependencies: StageDependency[];
};

/**
 * A profile generates stages and dependencies from a user prompt.
 * The `id` and `name` are used for display in the TUI profile picker.
 * `description` is a one-liner shown under the name.
 */
export type JobProfile = {
	id: string;
	name: string;
	description: string;
	generate: (prompt: string, stageCounter: number) => ProfileStages;
};

function stageId(prefix: string, counter: number): string {
	return `${prefix}-${counter}`;
}

function taskId(stagePrefix: string, counter: number, suffix = "work"): string {
	return `${stagePrefix}-${counter}-${suffix}`;
}

/**
 * Simplest profile — one stage, one task. The prompt becomes the task
 * prompt directly. Like starting a single coding agent session.
 */
export const singleTaskProfile: JobProfile = {
	id: "single",
	name: "Single task",
	description: "Run one agent session with your prompt",
	generate(prompt, counter) {
		const sid = stageId("task", counter);
		return {
			stages: [{
				id: sid,
				name: prompt.slice(0, 60),
				tasks: [{ id: taskId("task", counter), prompt }],
			}],
			dependencies: [],
		};
	},
};

/**
 * Two-phase profile — a planning stage followed by an execution stage.
 * The plan stage's transition injects the plan summary into the
 * execution stage's task context.
 */
export const planExecuteProfile: JobProfile = {
	id: "plan-execute",
	name: "Plan → Execute",
	description: "Plan first, then execute based on the plan",
	generate(prompt, counter) {
		const planId = stageId("plan", counter);
		const execId = stageId("execute", counter);

		const planToExec: TransitionFn = (results: TaskResult[], _dag: DAGMutator) => {
			const planSummary = results.map((r) => r.summary).join("\n");
			const execStage = _dag.getStage(execId);
			if (execStage && execStage.tasks.length > 0) {
				execStage.tasks[0].context = {
					...execStage.tasks[0].context,
					planSummary,
				};
			}
		};

		return {
			stages: [
				{
					id: planId,
					name: "Plan",
					tasks: [{
						id: taskId("plan", counter),
						prompt: [
							"Analyze the following request and produce a detailed implementation plan.",
							"Focus on what files to change, what approach to take, and potential risks.",
							"Do NOT make changes yet — only plan.",
							"",
							`Request: ${prompt}`,
						].join("\n"),
					}],
				},
				{
					id: execId,
					name: "Execute",
					tasks: [{
						id: taskId("execute", counter),
						prompt: [
							"Execute the following request according to the plan provided in context.",
							"",
							`Request: ${prompt}`,
						].join("\n"),
					}],
				},
			],
			dependencies: [{
				parentStageId: planId,
				childStageId: execId,
				transition: planToExec,
			}],
		};
	},
};

/**
 * Three-phase profile — plan, implement, review. The review stage
 * inspects the implementation result and can either approve (let the
 * job go idle) or reject (reset the implement stage for another pass).
 */
export const planImplementReviewProfile: JobProfile = {
	id: "plan-implement-review",
	name: "Plan → Implement → Review",
	description: "Plan, implement, then self-review with retry loop",
	generate(prompt, counter) {
		const planId = stageId("plan", counter);
		const implId = stageId("impl", counter);
		const reviewId = stageId("review", counter);
		const doneId = stageId("done", counter);

		const planToImpl: TransitionFn = (results, dag) => {
			const planSummary = results.map((r) => r.summary).join("\n");
			const implStage = dag.getStage(implId);
			if (implStage && implStage.tasks.length > 0) {
				implStage.tasks[0].context = {
					...implStage.tasks[0].context,
					planSummary,
				};
			}
		};

		const reviewTransition: TransitionFn = (results, dag) => {
			const approved = results.every(
				(r) => r.signals?.approved === true,
			);
			if (!approved) {
				const feedback = results
					.filter((r) => r.signals?.approved !== true)
					.map((r) => r.summary)
					.join("\n");
				const implStage = dag.getStage(implId);
				if (implStage && implStage.tasks.length > 0) {
					implStage.tasks[0].context = {
						...implStage.tasks[0].context,
						reviewFeedback: feedback,
					};
				}
				dag.resetStage(implId);
				dag.resetStage(reviewId);
			}
		};

		return {
			stages: [
				{
					id: planId,
					name: "Plan",
					tasks: [{
						id: taskId("plan", counter),
						prompt: [
							"Analyze the following request and produce a detailed implementation plan.",
							"Focus on what files to change, what approach to take, and potential risks.",
							"Do NOT make changes yet — only plan.",
							"",
							`Request: ${prompt}`,
						].join("\n"),
					}],
				},
				{
					id: implId,
					name: "Implement",
					tasks: [{
						id: taskId("impl", counter),
						prompt: [
							"Implement the following request according to the plan provided in context.",
							"If review feedback is provided in context, address those issues.",
							"",
							`Request: ${prompt}`,
						].join("\n"),
					}],
					maxStageAttempts: 3,
				},
				{
					id: reviewId,
					name: "Review",
					tasks: [{
						id: taskId("review", counter),
						prompt: [
							"Review the implementation for the following request.",
							"Check for correctness, edge cases, code quality, and completeness.",
							"Set signals.approved to true if the implementation is satisfactory,",
							"or false with a summary of what needs to change.",
							"",
							`Request: ${prompt}`,
						].join("\n"),
					}],
				},
				{
					id: doneId,
					name: "Done",
					tasks: [],
				},
			],
			dependencies: [
				{ parentStageId: planId, childStageId: implId, transition: planToImpl },
				{ parentStageId: implId, childStageId: reviewId },
				{ parentStageId: reviewId, childStageId: doneId, transition: reviewTransition },
			],
		};
	},
};

export const builtinProfiles: JobProfile[] = [
	singleTaskProfile,
	planExecuteProfile,
	planImplementReviewProfile,
];

export function getProfile(id: string): JobProfile | undefined {
	return builtinProfiles.find((p) => p.id === id);
}
