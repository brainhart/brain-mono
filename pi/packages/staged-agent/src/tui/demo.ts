#!/usr/bin/env node
/**
 * Demo script for the staged-agent TUI.
 *
 * Runs a mock job with simulated tasks that emit streaming progress
 * (tool calls, text chunks) and report token usage. Demonstrates
 * all five TUI primitives:
 *   1. Streaming task output (progress events in task view)
 *   2. Pause with reason (transition function pauses with explanation)
 *   3. Task-level cancellation (x key in task view)
 *   4. Resume with input (r key passes input to scheduler)
 *   5. Token/cost aggregation (dashboard summary)
 *
 * Usage:
 *   node dist/tui/demo.js
 */

import { JobRunner } from "../job-runner.js";
import type { JobDefinition, TaskDefinition, SessionId, TaskResult, TaskProgressCallback } from "../types.js";
import { TuiApp } from "./app.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const TOOL_NAMES = ["read", "grep", "edit", "bash", "write"];

function mockStreamingExecutor(delayMs: number, failRate = 0) {
	return async (
		task: TaskDefinition,
		_sessionId: SessionId,
		signal: AbortSignal,
		onProgress?: TaskProgressCallback,
	): Promise<TaskResult> => {
		const steps = 6;
		const stepMs = delayMs / steps;

		onProgress?.({ kind: "status", text: `Starting ${task.id}…` });
		await sleep(stepMs);

		for (let i = 0; i < steps - 1; i++) {
			if (signal.aborted) return { status: "failure", summary: "Aborted" };

			if (i % 2 === 0) {
				const tool = TOOL_NAMES[i % TOOL_NAMES.length];
				onProgress?.({ kind: "tool_call", toolName: tool, toolArgs: { path: `src/${task.id}.ts` } });
				await sleep(stepMs / 2);
				onProgress?.({ kind: "tool_result", text: `Found 42 lines in ${task.id}.ts` });
				await sleep(stepMs / 2);
			} else {
				onProgress?.({ kind: "text", text: `Analyzing ${task.id} step ${i + 1}/${steps}…` });
				await sleep(stepMs);
			}
		}

		if (Math.random() < failRate) {
			return { status: "failure", summary: `Simulated failure for ${task.id}` };
		}

		const inputTokens = 500 + Math.floor(Math.random() * 1000);
		const outputTokens = 200 + Math.floor(Math.random() * 500);
		return {
			status: "success",
			summary: `Completed ${task.id}: ${task.prompt.slice(0, 60)}`,
			signals: {
				model: "mock-gpt-5",
				usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
			},
		};
	};
}

const definition: JobDefinition = {
	id: "demo-job",
	stages: [
		{
			id: "plan",
			name: "Planning",
			tasks: [
				{ id: "plan-analyze", prompt: "Analyze the codebase and identify key components to modify" },
				{ id: "plan-design", prompt: "Design the implementation approach for the new feature" },
			],
		},
		{
			id: "impl",
			name: "Implementation",
			tasks: [
				{ id: "impl-auth", prompt: "Implement authentication middleware with JWT support" },
				{ id: "impl-api", prompt: "Build REST API endpoints for user management" },
				{ id: "impl-db", prompt: "Create database schema and migration scripts" },
			],
		},
		{
			id: "test",
			name: "Testing",
			tasks: [
				{ id: "test-unit", prompt: "Write unit tests for auth and API modules" },
				{ id: "test-integration", prompt: "Write integration tests for the full API flow" },
			],
		},
		{
			id: "review",
			name: "Code Review",
			tasks: [
				{ id: "review-security", prompt: "Review for security vulnerabilities and best practices" },
				{ id: "review-perf", prompt: "Review for performance issues and optimization opportunities" },
			],
		},
	],
	dependencies: [
		{ parentStageId: "plan", childStageId: "impl" },
		{ parentStageId: "impl", childStageId: "test" },
		{ parentStageId: "test", childStageId: "review" },
	],
};

async function main() {
	const executor = mockStreamingExecutor(3000, 0.1);
	const runner = new JobRunner(definition, executor, { concurrency: 3 });
	const tui = new TuiApp(runner, definition);

	tui.start();

	try {
		const result = await runner.run();
		await sleep(1500);
		tui.stop();

		console.log("\n\nJob finished:", result.status);
		if (result.error) {
			console.log("Error:", result.error);
		}
		for (const [stageId, results] of result.stageResults) {
			console.log(`  Stage ${stageId}:`);
			for (const r of results) {
				console.log(`    [${r.status}] ${r.summary.slice(0, 80)}`);
			}
		}
	} catch (err) {
		tui.stop();
		console.error("Job error:", err);
	}
}

main().catch(console.error);
