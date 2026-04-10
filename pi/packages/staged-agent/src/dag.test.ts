import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MutableDAG } from "./dag.js";
import type { StageDefinition } from "./types.js";

function makeStage(id: string, name?: string): StageDefinition {
	return {
		id,
		name: name ?? id,
		tasks: [{ id: `${id}-task-1`, prompt: `Do ${id}` }],
	};
}

describe("MutableDAG", () => {
	it("creates an empty DAG", () => {
		const dag = new MutableDAG();
		assert.equal(dag.size, 0);
		assert.deepEqual(dag.getStageIds(), []);
	});

	it("adds stages and queries them", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("plan"));
		dag.addStage(makeStage("implement"));
		assert.equal(dag.size, 2);
		assert.deepEqual(dag.getStage("plan")?.name, "plan");
	});

	it("rejects duplicate stage ids", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("plan"));
		assert.throws(() => dag.addStage(makeStage("plan")), /already exists/);
	});

	it("adds dependencies and queries parents/children", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("plan"));
		dag.addStage(makeStage("implement"));
		dag.addStage(makeStage("review"));
		dag.addDependency("plan", "implement");
		dag.addDependency("implement", "review");

		assert.deepEqual(dag.getParentStageIds("implement"), ["plan"]);
		assert.deepEqual(dag.getChildStageIds("plan"), ["implement"]);
		assert.deepEqual(dag.getRootStageIds(), ["plan"]);
		assert.deepEqual(dag.getLeafStageIds(), ["review"]);
	});

	it("rejects dependency to missing stage", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("plan"));
		assert.throws(
			() => dag.addDependency("plan", "missing"),
			/not in DAG/,
		);
	});

	it("rejects duplicate edges", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("a"));
		dag.addStage(makeStage("b"));
		dag.addDependency("a", "b");
		assert.throws(
			() => dag.addDependency("a", "b"),
			/already exists/,
		);
	});

	it("builds from definition", () => {
		const dag = MutableDAG.fromDefinition(
			[makeStage("a"), makeStage("b"), makeStage("c")],
			[
				{ parentStageId: "a", childStageId: "b" },
				{ parentStageId: "b", childStageId: "c" },
			],
		);
		assert.equal(dag.size, 3);
		assert.deepEqual(dag.getRootStageIds(), ["a"]);
		assert.deepEqual(dag.getLeafStageIds(), ["c"]);
	});

	it("supports fan-out and fan-in", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("plan"));
		dag.addStage(makeStage("impl-a"));
		dag.addStage(makeStage("impl-b"));
		dag.addStage(makeStage("merge"));
		dag.addDependency("plan", "impl-a");
		dag.addDependency("plan", "impl-b");
		dag.addDependency("impl-a", "merge");
		dag.addDependency("impl-b", "merge");

		assert.deepEqual(dag.getChildStageIds("plan").sort(), [
			"impl-a",
			"impl-b",
		]);
		assert.deepEqual(dag.getParentStageIds("merge").sort(), [
			"impl-a",
			"impl-b",
		]);
		assert.deepEqual(dag.getRootStageIds(), ["plan"]);
		assert.deepEqual(dag.getLeafStageIds(), ["merge"]);
	});

	it("stores transition function on dependency", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("a"));
		dag.addStage(makeStage("b"));
		const fn = () => {};
		dag.addDependency("a", "b", fn);
		const dep = dag.getDependency("a", "b");
		assert.equal(dep?.transition, fn);
	});

	it("resetStage queues a reset request", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("a"));
		dag.resetStage("a");
		const resets = dag.consumeResetRequests();
		assert.deepEqual(resets, ["a"]);
		assert.deepEqual(dag.consumeResetRequests(), []);
	});

	it("resetStage throws for unknown stage", () => {
		const dag = new MutableDAG();
		assert.throws(() => dag.resetStage("missing"), /not in DAG/);
	});

	it("pause queues a pause request", () => {
		const dag = new MutableDAG();
		assert.deepEqual(dag.consumePauseRequest(), { paused: false, reason: undefined });
		dag.pause("awaiting human review");
		assert.deepEqual(dag.consumePauseRequest(), { paused: true, reason: "awaiting human review" });
		assert.deepEqual(dag.consumePauseRequest(), { paused: false, reason: undefined });
	});

	it("rejects self-loops", () => {
		const dag = new MutableDAG();
		dag.addStage(makeStage("a"));
		assert.throws(
			() => dag.addDependency("a", "a"),
			/Self-loop/,
		);
	});
});
