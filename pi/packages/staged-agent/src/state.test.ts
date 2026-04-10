import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectState } from "./state.js";
import type { RuntimeEvent } from "./events.js";

describe("projectState", () => {
	it("projects job_submitted into running state with waiting stages", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1", "s2"],
				timestamp: 1,
			},
		];
		const state = projectState(events);
		assert.equal(state.jobId, "j1");
		assert.equal(state.status, "running");
		assert.equal(state.stages.get("s1")?.status, "waiting");
		assert.equal(state.stages.get("s2")?.status, "waiting");
	});

	it("projects a full lifecycle", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1"],
				timestamp: 1,
			},
			{
				type: "stage_submitted",
				jobId: "j1",
				stageId: "s1",
				timestamp: 2,
			},
			{
				type: "stage_attempt_started",
				jobId: "j1",
				stageId: "s1",
				stageAttemptId: "s1:attempt:1",
				attemptNumber: 1,
				timestamp: 3,
			},
			{
				type: "task_started",
				jobId: "j1",
				taskId: "t1",
				taskAttemptId: "t1:s1:1",
				stageAttemptId: "s1:attempt:1",
				attemptNumber: 1,
				timestamp: 4,
			},
			{
				type: "task_completed",
				jobId: "j1",
				taskId: "t1",
				taskAttemptId: "t1:s1:1",
				result: { status: "success", summary: "done" },
				timestamp: 5,
			},
			{
				type: "stage_completed",
				jobId: "j1",
				stageId: "s1",
				timestamp: 6,
			},
			{
				type: "job_completed",
				jobId: "j1",
				timestamp: 7,
			},
		];

		const state = projectState(events);
		assert.equal(state.status, "completed");
		assert.equal(state.stages.get("s1")?.status, "completed");
		assert.equal(state.tasks.get("t1")?.status, "completed");
		assert.equal(state.tasks.get("t1")?.result?.summary, "done");
	});

	it("projects job failure", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1"],
				timestamp: 1,
			},
			{
				type: "stage_failed",
				jobId: "j1",
				stageId: "s1",
				error: "boom",
				timestamp: 2,
			},
			{
				type: "job_failed",
				jobId: "j1",
				error: "boom",
				timestamp: 3,
			},
		];

		const state = projectState(events);
		assert.equal(state.status, "failed");
		assert.equal(state.stages.get("s1")?.status, "failed");
	});
});
