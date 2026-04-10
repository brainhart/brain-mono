import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JobRunner } from "./job-runner.js";
import { InMemorySessionPool } from "./session-pool.js";
import type {
	JobDefinition,
	TaskExecutor,
	StageDefinition,
	StageDependency,
	TaskResult,
	DAGMutator,
} from "./types.js";

function makeStage(
	id: string,
	taskIds?: string[],
	opts?: Partial<StageDefinition>,
): StageDefinition {
	const tids = taskIds ?? [`${id}-task`];
	return {
		id,
		name: id,
		tasks: tids.map((tid) => ({ id: tid, prompt: `Do ${tid}` })),
		...opts,
	};
}

const successExecutor: TaskExecutor = async () => ({
	status: "success",
	summary: "done",
});

describe("JobRunner", () => {
	it("runs a single-stage job", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan")],
			dependencies: [],
		};
		const result = await new JobRunner(
			def,
			new InMemorySessionPool(),
			successExecutor,
		).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 1);
		assert.ok(result.stageResults.has("plan"));
	});

	it("runs a linear chain of stages", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan"), makeStage("implement"), makeStage("review")],
			dependencies: [
				{ parentStageId: "plan", childStageId: "implement" },
				{ parentStageId: "implement", childStageId: "review" },
			],
		};
		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};
		const result = await new JobRunner(
			def,
			new InMemorySessionPool(),
			executor,
		).run();
		assert.equal(result.status, "completed");
		assert.deepEqual(order, [
			"plan-task",
			"implement-task",
			"review-task",
		]);
	});

	it("runs parallel stages", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("plan"),
				makeStage("impl-a"),
				makeStage("impl-b"),
				makeStage("merge"),
			],
			dependencies: [
				{ parentStageId: "plan", childStageId: "impl-a" },
				{ parentStageId: "plan", childStageId: "impl-b" },
				{ parentStageId: "impl-a", childStageId: "merge" },
				{ parentStageId: "impl-b", childStageId: "merge" },
			],
		};
		const started = new Set<string>();
		const executor: TaskExecutor = async (task) => {
			started.add(task.id);
			return { status: "success", summary: "done" };
		};
		const result = await new JobRunner(
			def,
			new InMemorySessionPool(),
			executor,
		).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 4);
	});

	it("reports failure when a stage fails", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan"), makeStage("implement")],
			dependencies: [
				{ parentStageId: "plan", childStageId: "implement" },
			],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "implement-task") throw new Error("compile error");
			return { status: "success", summary: "done" };
		};
		const result = await new JobRunner(
			def,
			new InMemorySessionPool(),
			executor,
			{ },
		).run();
		assert.equal(result.status, "failed");
		assert.ok(result.error);
	});

	it("retries a stage on failure with maxStageAttempts", async () => {
		let attemptCount = 0;
		const def: JobDefinition = {
			stages: [makeStage("flaky", ["t1"], { maxStageAttempts: 3 })],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			attemptCount++;
			if (attemptCount < 3) throw new Error("transient");
			return { status: "success", summary: "done" };
		};
		const result = await new JobRunner(
			def,
			new InMemorySessionPool(),
			executor,
		).run();
		assert.equal(result.status, "completed");
		assert.equal(attemptCount, 3);
	});

	it("supports transition functions for adaptive replanning", async () => {
		const planTransition = (
			_parentResults: TaskResult[],
			dag: DAGMutator,
		) => {
			dag.addStage({
				id: "finalize",
				name: "finalize",
				tasks: [{ id: "finalize-task", prompt: "Wrap up" }],
			});
			dag.addDependency("review", "finalize");
		};

		const def: JobDefinition = {
			stages: [makeStage("plan"), makeStage("review")],
			dependencies: [
				{
					parentStageId: "plan",
					childStageId: "review",
					transition: planTransition,
				},
			],
		};

		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};

		const result = await new JobRunner(
			def,
			new InMemorySessionPool(),
			executor,
		).run();
		assert.equal(result.status, "completed");
		assert.ok(result.stageResults.has("finalize"));
		assert.deepEqual(order, [
			"plan-task",
			"review-task",
			"finalize-task",
		]);
	});

	it("emits events and can replay state from the log", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan")],
			dependencies: [],
		};
		const runner = new JobRunner(
			def,
			new InMemorySessionPool(),
			successExecutor,
		);
		await runner.run();
		const events = runner.getEventLog().getEvents();
		assert.ok(events.length > 0);
		const types = events.map((e) => e.type);
		assert.ok(types.includes("job_submitted"));
		assert.ok(types.includes("job_completed"));
		assert.ok(types.includes("stage_submitted"));
		assert.ok(types.includes("stage_completed"));
		assert.ok(types.includes("task_started"));
		assert.ok(types.includes("task_completed"));
	});
});
