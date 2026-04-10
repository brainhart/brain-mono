import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	singleTaskProfile,
	planExecuteProfile,
	planImplementReviewProfile,
	builtinProfiles,
	getProfile,
} from "./profiles.js";

describe("singleTaskProfile", () => {
	it("generates one stage with one task", () => {
		const result = singleTaskProfile.generate("Fix the login bug", 1);
		assert.equal(result.stages.length, 1);
		assert.equal(result.dependencies.length, 0);
		assert.equal(result.stages[0].tasks.length, 1);
		assert.ok(result.stages[0].tasks[0].prompt.includes("Fix the login bug"));
	});

	it("uses the prompt as the stage name (truncated)", () => {
		const longPrompt = "A".repeat(100);
		const result = singleTaskProfile.generate(longPrompt, 2);
		assert.ok(result.stages[0].name.length <= 60);
	});

	it("generates unique IDs for different counters", () => {
		const r1 = singleTaskProfile.generate("task one", 1);
		const r2 = singleTaskProfile.generate("task two", 2);
		assert.notEqual(r1.stages[0].id, r2.stages[0].id);
		assert.notEqual(r1.stages[0].tasks[0].id, r2.stages[0].tasks[0].id);
	});
});

describe("planExecuteProfile", () => {
	it("generates two stages with one dependency", () => {
		const result = planExecuteProfile.generate("Add dark mode", 1);
		assert.equal(result.stages.length, 2);
		assert.equal(result.dependencies.length, 1);

		const [plan, execute] = result.stages;
		assert.ok(plan.name.includes("Plan"));
		assert.ok(execute.name.includes("Execute"));

		assert.equal(result.dependencies[0].parentStageId, plan.id);
		assert.equal(result.dependencies[0].childStageId, execute.id);
	});

	it("plan stage prompt tells agent not to make changes", () => {
		const result = planExecuteProfile.generate("Add dark mode", 1);
		assert.ok(result.stages[0].tasks[0].prompt.includes("Do NOT make changes"));
	});

	it("has a transition function on the dependency", () => {
		const result = planExecuteProfile.generate("Add dark mode", 1);
		assert.ok(result.dependencies[0].transition);
	});
});

describe("planImplementReviewProfile", () => {
	it("generates four stages (plan, impl, review, done) with dependencies", () => {
		const result = planImplementReviewProfile.generate("Refactor auth", 1);
		assert.equal(result.stages.length, 4);
		assert.ok(result.dependencies.length >= 2);

		const stageNames = result.stages.map((s) => s.name);
		assert.ok(stageNames.includes("Plan"));
		assert.ok(stageNames.includes("Implement"));
		assert.ok(stageNames.includes("Review"));
		assert.ok(stageNames.includes("Done"));
	});

	it("impl stage has maxStageAttempts for retry loop", () => {
		const result = planImplementReviewProfile.generate("Refactor auth", 1);
		const impl = result.stages.find((s) => s.name === "Implement");
		assert.ok(impl);
		assert.ok((impl.maxStageAttempts ?? 0) > 1);
	});

	it("review → done dependency has a transition (reset loop)", () => {
		const result = planImplementReviewProfile.generate("Refactor auth", 1);
		const reviewStage = result.stages.find((s) => s.name === "Review");
		const doneStage = result.stages.find((s) => s.name === "Done");
		assert.ok(reviewStage && doneStage);

		const reviewToDone = result.dependencies.find(
			(d) => d.parentStageId === reviewStage.id && d.childStageId === doneStage.id,
		);
		assert.ok(reviewToDone);
		assert.ok(reviewToDone.transition);
	});
});

describe("builtinProfiles", () => {
	it("contains three profiles", () => {
		assert.equal(builtinProfiles.length, 3);
	});

	it("all profiles have unique ids", () => {
		const ids = builtinProfiles.map((p) => p.id);
		assert.equal(new Set(ids).size, ids.length);
	});
});

describe("getProfile", () => {
	it("returns a profile by id", () => {
		const p = getProfile("single");
		assert.ok(p);
		assert.equal(p.id, "single");
	});

	it("returns undefined for unknown id", () => {
		assert.equal(getProfile("nonexistent"), undefined);
	});
});
