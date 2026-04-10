import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskSetManager } from "./task-set-manager.js";
import { TaskRunner } from "./task-runner.js";
import { EventLog } from "./event-log.js";
import { InMemorySessionPool } from "./session-pool.js";
import type { TaskDefinition, TaskResult, TaskExecutor } from "./types.js";

function makeTask(id: string): TaskDefinition {
	return { id, prompt: `Do ${id}` };
}

function makeRunner(executor: TaskExecutor): TaskRunner {
	return new TaskRunner(new InMemorySessionPool(), executor, new EventLog());
}

describe("TaskSetManager", () => {
	it("completes when all tasks succeed (policy=all)", async () => {
		const executor: TaskExecutor = async () => ({
			status: "success",
			summary: "ok",
		});
		const runner = makeRunner(executor);
		const tsm = new TaskSetManager(
			"s1",
			"s1:attempt:1",
			"j1",
			[makeTask("t1"), makeTask("t2")],
			runner,
		);
		const outcome = await tsm.execute();
		assert.equal(outcome.status, "completed");
		assert.equal(outcome.results.length, 2);
	});

	it("fails when a task fails beyond retries (policy=all)", async () => {
		let callCount = 0;
		const executor: TaskExecutor = async () => {
			callCount++;
			throw new Error("nope");
		};
		const runner = makeRunner(executor);
		const tsm = new TaskSetManager(
			"s1",
			"s1:attempt:1",
			"j1",
			[makeTask("t1")],
			runner,
			{ maxTaskAttempts: 2 },
		);
		const outcome = await tsm.execute();
		assert.equal(outcome.status, "failed");
		assert.equal(callCount, 2);
	});

	it("completes on first_success policy", async () => {
		let callIndex = 0;
		const executor: TaskExecutor = async () => {
			callIndex++;
			if (callIndex === 1) return { status: "failure", summary: "nah" };
			return { status: "success", summary: "ok" };
		};
		const runner = makeRunner(executor);
		const tsm = new TaskSetManager(
			"s1",
			"s1:attempt:1",
			"j1",
			[makeTask("t1"), makeTask("t2")],
			runner,
			{ completionPolicy: { type: "first_success" } },
		);
		const outcome = await tsm.execute();
		assert.equal(outcome.status, "completed");
	});

	it("evaluates quorum policy", async () => {
		let callIndex = 0;
		const executor: TaskExecutor = async () => {
			callIndex++;
			if (callIndex <= 2) return { status: "success", summary: "ok" };
			return { status: "failure", summary: "nah" };
		};
		const runner = makeRunner(executor);
		const tsm = new TaskSetManager(
			"s1",
			"s1:attempt:1",
			"j1",
			[makeTask("t1"), makeTask("t2"), makeTask("t3")],
			runner,
			{ completionPolicy: { type: "quorum", n: 2 } },
		);
		const outcome = await tsm.execute();
		assert.equal(outcome.status, "completed");
	});

	it("evaluates predicate policy", async () => {
		const executor: TaskExecutor = async () => ({
			status: "success",
			summary: "ok",
			signals: { approved: true },
		});
		const runner = makeRunner(executor);
		const tsm = new TaskSetManager(
			"s1",
			"s1:attempt:1",
			"j1",
			[makeTask("t1")],
			runner,
			{
				completionPolicy: {
					type: "predicate",
					fn: (results: TaskResult[]) =>
						results.every(
							(r) =>
								r.status === "success" &&
								(r.signals as Record<string, unknown>)?.approved === true,
						),
				},
			},
		);
		const outcome = await tsm.execute();
		assert.equal(outcome.status, "completed");
	});
});
