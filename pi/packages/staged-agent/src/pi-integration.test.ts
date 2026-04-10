import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { JobRunner } from "./job-runner.js";
import { createPiExecutor } from "./pi-executor.js";
import { projectState } from "./state.js";
import type { JobDefinition, TaskResult, DAGMutator } from "./types.js";

const PI_BINARY = path.resolve(
	import.meta.dirname,
	"../../../..",
	"bin/pi",
);

const piAvailable = fs.existsSync(PI_BINARY);
const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
const canRun = piAvailable && hasAnthropicKey;

const executor = createPiExecutor({
	piBinary: PI_BINARY,
	provider: "anthropic",
	model: "claude-sonnet-4-20250514",
});

describe("Pi integration — single stage", { skip: !canRun }, () => {
	it("runs a single task through pi and gets a result", async () => {
		const def: JobDefinition = {
			stages: [
				{
					id: "greet",
					name: "greet",
					tasks: [
						{
							id: "say-hello",
							prompt:
								'Respond with exactly the JSON object: {"greeting":"hello world"}. No markdown, no code fences, just the raw JSON.',
						},
					],
					taskTimeoutMs: 30_000,
				},
			],
			dependencies: [],
		};

		const runner = new JobRunner(def, executor);
		const result = await runner.run();

		assert.equal(result.status, "completed");
		assert.ok(result.stageResults.has("greet"));

		const greetResults = result.stageResults.get("greet")!;
		assert.equal(greetResults.length, 1);
		assert.equal(greetResults[0].status, "success");
		assert.ok(greetResults[0].summary.length > 0);
		console.log("  Pi response:", greetResults[0].summary);
	});
});

describe("Pi integration — linear chain", { skip: !canRun }, () => {
	it("runs plan → implement in sequence", async () => {
		const def: JobDefinition = {
			stages: [
				{
					id: "plan",
					name: "plan",
					tasks: [
						{
							id: "plan-task",
							prompt:
								"You are a planning assistant. List exactly 3 steps to make a hello world program in Python. Be concise — one line per step.",
						},
					],
					taskTimeoutMs: 30_000,
				},
				{
					id: "implement",
					name: "implement",
					tasks: [
						{
							id: "implement-task",
							prompt:
								'Write a one-line Python hello world program. Respond with only the code, no markdown.',
						},
					],
					taskTimeoutMs: 30_000,
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

		console.log("  Plan:", planResult.summary.slice(0, 100));
		console.log("  Impl:", implResult.summary.slice(0, 100));
	});
});

describe("Pi integration — parallel stages", { skip: !canRun }, () => {
	it("runs two review tasks in parallel and merges", async () => {
		const def: JobDefinition = {
			stages: [
				{
					id: "code",
					name: "code",
					tasks: [
						{
							id: "code-task",
							prompt:
								'Respond with exactly: print("hello")',
						},
					],
					taskTimeoutMs: 30_000,
				},
				{
					id: "review-a",
					name: "review-a",
					tasks: [
						{
							id: "review-a-task",
							prompt:
								'You are a code reviewer. Respond with exactly: {"approved": true, "comment": "LGTM"}',
						},
					],
					taskTimeoutMs: 30_000,
				},
				{
					id: "review-b",
					name: "review-b",
					tasks: [
						{
							id: "review-b-task",
							prompt:
								'You are a security reviewer. Respond with exactly: {"approved": true, "comment": "No issues"}',
						},
					],
					taskTimeoutMs: 30_000,
				},
				{
					id: "merge",
					name: "merge",
					tasks: [
						{
							id: "merge-task",
							prompt:
								'Respond with exactly: {"status": "merged"}',
						},
					],
					taskTimeoutMs: 30_000,
				},
			],
			dependencies: [
				{ parentStageId: "code", childStageId: "review-a" },
				{ parentStageId: "code", childStageId: "review-b" },
				{ parentStageId: "review-a", childStageId: "merge" },
				{ parentStageId: "review-b", childStageId: "merge" },
			],
		};

		const runner = new JobRunner(def, executor);
		const result = await runner.run();

		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 4);

		for (const [stageId, results] of result.stageResults) {
			assert.equal(results[0].status, "success", `${stageId} failed`);
			console.log(`  ${stageId}: ${results[0].summary.slice(0, 80)}`);
		}
	});
});

describe("Pi integration — transition function", { skip: !canRun }, () => {
	it("dynamically adds a finalize stage via transition", async () => {
		const addFinalize = (_results: TaskResult[], dag: DAGMutator) => {
			dag.addStage({
				id: "finalize",
				name: "finalize",
				tasks: [
					{
						id: "finalize-task",
						prompt: 'Respond with exactly: done',
					},
				],
				taskTimeoutMs: 30_000,
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
							prompt: 'Respond with exactly: planned',
						},
					],
					taskTimeoutMs: 30_000,
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

		const runner = new JobRunner(def, executor);
		const result = await runner.run();

		assert.equal(result.status, "completed");
		assert.ok(result.stageResults.has("finalize"));
		console.log(
			"  Finalize:",
			result.stageResults.get("finalize")![0].summary,
		);
	});
});

describe(
	"Pi integration — event log round-trip",
	{ skip: !canRun },
	() => {
		it("produces a replayable event log", async () => {
			const def: JobDefinition = {
				id: "e2e-log-test",
				stages: [
					{
						id: "s1",
						name: "s1",
						tasks: [
							{
								id: "t1",
								prompt: 'Respond with exactly: ok',
							},
						],
						taskTimeoutMs: 30_000,
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
			console.log(
				"  Events:",
				events.length,
				"| Types:",
				[...new Set(events.map((e) => e.type))].join(", "),
			);
		});
	},
);
