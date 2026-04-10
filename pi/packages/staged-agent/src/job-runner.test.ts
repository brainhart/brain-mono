import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JobRunner } from "./job-runner.js";
import type {
	JobDefinition,
	TaskExecutor,
	StageDefinition,
	TaskResult,
	DAGMutator,
} from "./types.js";
import { projectState } from "./state.js";

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

describe("JobRunner (actor-based)", () => {
	it("runs a single-stage job", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan")],
			dependencies: [],
		};
		const result = await new JobRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 1);
		assert.ok(result.stageResults.has("plan"));
	});

	it("runs a linear chain of stages in order", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("plan"),
				makeStage("implement"),
				makeStage("review"),
			],
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
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.deepEqual(order, [
			"plan-task",
			"implement-task",
			"review-task",
		]);
	});

	it("runs parallel stages (fan-out / fan-in)", async () => {
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
		const result = await new JobRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 4);
	});

	it("reports failure when a stage fails beyond retries", async () => {
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
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.error);
	});

	it("retries stages with maxStageAttempts", async () => {
		let attemptCount = 0;
		const def: JobDefinition = {
			stages: [
				makeStage("flaky", ["t1"], { maxStageAttempts: 3 }),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			attemptCount++;
			if (attemptCount < 3) throw new Error("transient");
			return { status: "success", summary: "done" };
		};
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.equal(attemptCount, 3);
	});

	it("retries tasks within a stage", async () => {
		let callCount = 0;
		const def: JobDefinition = {
			stages: [
				makeStage("s1", ["t1"], { maxTaskAttempts: 3 }),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			callCount++;
			if (callCount < 3) throw new Error("flaky");
			return { status: "success", summary: "ok" };
		};
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.equal(callCount, 3);
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

		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.ok(result.stageResults.has("finalize"));
		assert.deepEqual(order, [
			"plan-task",
			"review-task",
			"finalize-task",
		]);
	});

	it("emits events and state can be projected from the log", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan")],
			dependencies: [],
		};
		const runner = new JobRunner(def, successExecutor);
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

		const state = projectState(events);
		assert.equal(state.status, "completed");
		assert.equal(state.stages.get("plan")?.status, "completed");
	});

	it("propagates failure to dependent stages", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("a"),
				makeStage("b"),
				makeStage("c"),
			],
			dependencies: [
				{ parentStageId: "a", childStageId: "b" },
				{ parentStageId: "b", childStageId: "c" },
			],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "a-task") throw new Error("fail");
			return { status: "success", summary: "done" };
		};
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.error?.includes("a"));
	});

	it("handles multi-task stages with all-policy", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("review", ["r1", "r2", "r3"]),
			],
			dependencies: [],
		};
		let count = 0;
		const executor: TaskExecutor = async () => {
			count++;
			return { status: "success", summary: `review ${count}` };
		};
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.equal(count, 3);
		assert.equal(result.stageResults.get("review")?.length, 3);
	});

	it("completes with first_success policy on first passing task", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("race", ["fast", "slow"], {
					completionPolicy: { type: "first_success" },
				}),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "slow") {
				return { status: "failure", summary: "nah" };
			}
			return { status: "success", summary: "winner" };
		};
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "completed");
	});

	it("evaluates quorum policy", async () => {
		let idx = 0;
		const def: JobDefinition = {
			stages: [
				makeStage("votes", ["v1", "v2", "v3"], {
					completionPolicy: { type: "quorum", n: 2 },
				}),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			idx++;
			if (idx <= 2) return { status: "success", summary: "yes" };
			return { status: "failure", summary: "no" };
		};
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "completed");
	});

	it("preserves partial results on failure", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("ok-stage"),
				makeStage("bad-stage"),
			],
			dependencies: [
				{ parentStageId: "ok-stage", childStageId: "bad-stage" },
			],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "bad-stage-task") throw new Error("boom");
			return { status: "success", summary: "ok" };
		};
		const result = await new JobRunner(def, executor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.stageResults.has("ok-stage"));
	});

	it("cancels a running job", async () => {
		const def: JobDefinition = {
			stages: [makeStage("slow")],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			await new Promise((r) => setTimeout(r, 5000));
			return { status: "success", summary: "done" };
		};
		const runner = new JobRunner(def, executor);
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));
		runner.cancel();

		const result = await promise;
		assert.equal(result.status, "failed");
		assert.ok(result.error?.includes("cancel"));
	});

	it("handles empty job (zero stages)", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const result = await new JobRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 0);
	});
});
