#!/usr/bin/env node
/**
 * Demo script for the staged-agent TUI.
 *
 * Runs a mock job with simulated tasks (no real pi sessions) and
 * displays the TUI so you can navigate the hierarchy, pause/resume,
 * and watch stages complete in real-time.
 *
 * Usage:
 *   node dist/tui/demo.js
 */

import { JobRunner } from "../job-runner.js";
import type { JobDefinition, TaskDefinition, SessionId, TaskResult } from "../types.js";
import { TuiApp } from "./app.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockExecutor(delayMs: number, failRate = 0) {
	return async (
		task: TaskDefinition,
		_sessionId: SessionId,
		signal: AbortSignal,
	): Promise<TaskResult> => {
		const chunks = 10;
		const chunkMs = delayMs / chunks;
		for (let i = 0; i < chunks; i++) {
			if (signal.aborted) return { status: "failure", summary: "Aborted" };
			await sleep(chunkMs);
		}
		if (Math.random() < failRate) {
			return { status: "failure", summary: `Simulated failure for ${task.id}` };
		}
		return {
			status: "success",
			summary: `Completed ${task.id}: ${task.prompt.slice(0, 60)}`,
			signals: { model: "mock", tokens: Math.floor(Math.random() * 2000) },
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
	const executor = mockExecutor(3000, 0.1);
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
