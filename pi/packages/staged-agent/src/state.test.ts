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
				stageId: "s1",
				taskId: "t1",
				taskAttemptId: "t1:s1:1",
				stageAttemptId: "s1:attempt:1",
				attemptNumber: 1,
				timestamp: 4,
			},
			{
				type: "task_completed",
				jobId: "j1",
				stageId: "s1",
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
		assert.equal(state.tasks.get("t1")?.stageId, "s1");
		assert.equal(state.stageResults.get("s1")?.length, 1);
		assert.equal(
			state.stageResults.get("s1")?.[0].summary,
			"done",
		);
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

	it("handles dynamically-added stages from transition_evaluated", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1"],
				timestamp: 1,
			},
			{
				type: "stage_completed",
				jobId: "j1",
				stageId: "s1",
				timestamp: 2,
			},
			{
				type: "transition_evaluated",
				jobId: "j1",
				parentStageId: "s1",
				childStageId: "s2",
				addedStages: ["s2", "s3"],
				resetStages: [],
				timestamp: 3,
			},
		];

		const state = projectState(events);
		assert.equal(state.stages.size, 3);
		assert.equal(state.stages.get("s2")?.status, "waiting");
		assert.equal(state.stages.get("s3")?.status, "waiting");
	});

	it("handles stage_reset", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1"],
				timestamp: 1,
			},
			{
				type: "stage_completed",
				jobId: "j1",
				stageId: "s1",
				timestamp: 2,
			},
			{
				type: "stage_reset",
				jobId: "j1",
				stageId: "s1",
				timestamp: 3,
			},
		];

		const state = projectState(events);
		assert.equal(state.stages.get("s1")?.status, "waiting");
	});

	it("handles pause and resume", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1"],
				timestamp: 1,
			},
			{
				type: "job_paused",
				jobId: "j1",
				timestamp: 2,
			},
		];

		let state = projectState(events);
		assert.equal(state.status, "paused");

		events.push({
			type: "job_resumed",
			jobId: "j1",
			timestamp: 3,
		});
		state = projectState(events);
		assert.equal(state.status, "running");
	});

	it("populates stageResults from task_completed events", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1"],
				timestamp: 1,
			},
			{
				type: "task_started",
				jobId: "j1",
				stageId: "s1",
				taskId: "t1",
				taskAttemptId: "t1:a",
				stageAttemptId: "s1:attempt:1",
				attemptNumber: 1,
				timestamp: 2,
			},
			{
				type: "task_completed",
				jobId: "j1",
				stageId: "s1",
				taskId: "t1",
				taskAttemptId: "t1:a",
				result: { status: "success", summary: "ok" },
				timestamp: 3,
			},
			{
				type: "task_started",
				jobId: "j1",
				stageId: "s1",
				taskId: "t2",
				taskAttemptId: "t2:a",
				stageAttemptId: "s1:attempt:1",
				attemptNumber: 1,
				timestamp: 4,
			},
			{
				type: "task_completed",
				jobId: "j1",
				stageId: "s1",
				taskId: "t2",
				taskAttemptId: "t2:a",
				result: { status: "success", summary: "also ok" },
				timestamp: 5,
			},
		];

		const state = projectState(events);
		assert.equal(state.stageResults.get("s1")?.length, 2);
	});

	it("tracks operator notes on tasks", () => {
		const events: RuntimeEvent[] = [
			{
				type: "job_submitted",
				jobId: "j1",
				stageIds: ["s1"],
				timestamp: 1,
			},
			{
				type: "task_started",
				jobId: "j1",
				stageId: "s1",
				taskId: "t1",
				taskAttemptId: "t1:a",
				stageAttemptId: "s1:attempt:1",
				attemptNumber: 1,
				timestamp: 2,
			},
			{
				type: "task_operator_note",
				jobId: "j1",
				stageId: "s1",
				taskId: "t1",
				note: "Please focus on auth edge cases.",
				action: "retry",
				timestamp: 3,
			},
		];

		const state = projectState(events);
		assert.deepEqual(state.tasks.get("t1")?.operatorNotes, [
			{
				note: "Please focus on auth edge cases.",
				action: "retry",
				timestamp: 3,
			},
		]);
	});
});
