/**
 * Integration tests using the native Pi session runtime.
 *
 * These tests create real AgentSessionRuntime instances, drive real
 * sessions via session.prompt(), and verify that the staged-agent
 * runtime correctly orchestrates them through the DAG.
 *
 * Requires: ANTHROPIC_API_KEY (or another provider key) in the environment.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { JobRunner } from "./job-runner.js";
import { PiSessionPool, createPiTaskExecutor } from "./pi-runtime.js";
import { projectState } from "./state.js";
import type { JobDefinition, TaskResult, DAGMutator } from "./types.js";

const hasApiKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY;
const canRun = hasApiKey;

let sharedPool: PiSessionPool | undefined;

function getPool(): PiSessionPool {
	if (!sharedPool) {
		sharedPool = new PiSessionPool({
			cwd: process.cwd(),
			concurrency: 2,
		});
	}
	return sharedPool;
}

after(async () => {
	if (sharedPool) {
		sharedPool.send({ type: "dispose" });
		await new Promise((r) => setTimeout(r, 500));
	}
});

describe(
	"Pi native — single stage",
	{ skip: !canRun && "No API key available" },
	() => {
		it("runs a single task through a real Pi session", async () => {
			const pool = getPool();
			const executor = createPiTaskExecutor({ pool });

			const def: JobDefinition = {
				stages: [
					{
						id: "greet",
						name: "greet",
						tasks: [
							{
								id: "say-hello",
								prompt:
									"Respond with exactly: hello world. Nothing else.",
							},
						],
						taskTimeoutMs: 60_000,
					},
				],
				dependencies: [],
			};

			const result = await new JobRunner(def, executor).run();

			assert.equal(result.status, "completed");
			assert.ok(result.stageResults.has("greet"));

			const greetResults = result.stageResults.get("greet")!;
			assert.equal(greetResults.length, 1);
			assert.equal(greetResults[0].status, "success");
			assert.ok(greetResults[0].summary.length > 0);

			assert.ok(greetResults[0].signals?.sessionFile);
			assert.ok(greetResults[0].signals?.sessionId);

			console.log("  Response:", greetResults[0].summary);
			console.log("  Session:", greetResults[0].signals?.sessionFile);
		});
	},
);

describe(
	"Pi native — linear chain with session lineage",
	{ skip: !canRun && "No API key available" },
	() => {
		it("runs plan → implement in order via real sessions", async () => {
			const pool = getPool();
			const executor = createPiTaskExecutor({ pool });

			const def: JobDefinition = {
				stages: [
					{
						id: "plan",
						name: "plan",
						tasks: [
							{
								id: "plan-task",
								prompt:
									"List exactly 2 steps to write a Python hello world. One line per step, no numbering.",
							},
						],
						taskTimeoutMs: 60_000,
					},
					{
						id: "implement",
						name: "implement",
						tasks: [
							{
								id: "impl-task",
								prompt:
									'Write a one-line Python hello world. Respond with only the code, no markdown.',
							},
						],
						taskTimeoutMs: 60_000,
					},
				],
				dependencies: [
					{ parentStageId: "plan", childStageId: "implement" },
				],
			};

			const runner = new JobRunner(def, executor);
			const result = await runner.run();

			assert.equal(result.status, "completed");
			assert.equal(result.stageResults.size, 2);

			const planResult = result.stageResults.get("plan")![0];
			const implResult = result.stageResults.get("implement")![0];
			assert.equal(planResult.status, "success");
			assert.equal(implResult.status, "success");

			console.log("  Plan:", planResult.summary.slice(0, 120));
			console.log("  Impl:", implResult.summary.slice(0, 120));
		});
	},
);

describe(
	"Pi native — event log captures real session metadata",
	{ skip: !canRun && "No API key available" },
	() => {
		it("produces a replayable event log with session info", async () => {
			const pool = getPool();
			const executor = createPiTaskExecutor({ pool });

			const def: JobDefinition = {
				id: "native-log-test",
				stages: [
					{
						id: "s1",
						name: "s1",
						tasks: [
							{
								id: "t1",
								prompt: "Respond with exactly: ok",
							},
						],
						taskTimeoutMs: 60_000,
					},
				],
				dependencies: [],
			};

			const runner = new JobRunner(def, executor);
			await runner.run();

			const events = runner.getEventLog().getEvents();
			const state = projectState(events);

			assert.equal(state.status, "completed");
			assert.equal(state.stages.get("s1")?.status, "completed");
			assert.ok(state.stageResults.get("s1")?.length);

			const types = [...new Set(events.map((e) => e.type))];
			assert.ok(types.includes("session_attached"));

			console.log(
				"  Events:",
				events.length,
				"| Types:",
				types.join(", "),
			);
		});
	},
);

describe(
	"Pi native — transition function with dynamic stages",
	{ skip: !canRun && "No API key available" },
	() => {
		it("dynamically materializes a finalize stage", async () => {
			const pool = getPool();
			const executor = createPiTaskExecutor({ pool });

			const addFinalize = (
				_results: TaskResult[],
				dag: DAGMutator,
			) => {
				dag.addStage({
					id: "finalize",
					name: "finalize",
					tasks: [
						{
							id: "finalize-task",
							prompt: "Respond with exactly: done",
						},
					],
					taskTimeoutMs: 60_000,
				});
				dag.addDependency("plan", "finalize");
			};

			const def: JobDefinition = {
				stages: [
					{
						id: "plan",
						name: "plan",
						tasks: [
							{
								id: "plan-task",
								prompt: "Respond with exactly: planned",
							},
						],
						taskTimeoutMs: 60_000,
					},
					{
						id: "placeholder",
						name: "placeholder",
						tasks: [],
					},
				],
				dependencies: [
					{
						parentStageId: "plan",
						childStageId: "placeholder",
						transition: addFinalize,
					},
				],
			};

			const result = await new JobRunner(def, executor).run();

			assert.equal(result.status, "completed");
			assert.ok(result.stageResults.has("finalize"));
			console.log(
				"  Finalize:",
				result.stageResults.get("finalize")![0].summary,
			);
		});
	},
);
