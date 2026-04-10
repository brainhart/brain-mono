#!/usr/bin/env node
/**
 * Interactive demo for the staged-agent TUI.
 *
 * Starts with an empty job in interactive mode — no pre-seeded stages.
 * The user submits tasks through the TUI prompt (n key), choosing a
 * profile that determines how many stages the task is broken into.
 *
 * Profiles:
 *   - Single task — one stage, one task, immediate execution
 *   - Plan → Execute — plan first, then execute based on the plan
 *   - Plan → Implement → Review — plan, implement, self-review loop
 *
 * Demonstrates the coding-agent workflow where the system is dropped
 * into a project and the user decides what to do next.
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

function mockStreamingExecutor() {
	return async (
		task: TaskDefinition,
		_sessionId: SessionId,
		signal: AbortSignal,
		onProgress?: TaskProgressCallback,
	): Promise<TaskResult> => {
		const delayMs = 2000 + Math.random() * 3000;
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

		const inputTokens = 500 + Math.floor(Math.random() * 1000);
		const outputTokens = 200 + Math.floor(Math.random() * 500);

		const isReview = task.id.includes("review");
		const signals: Record<string, unknown> = {
			model: "mock-gpt-5",
			usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
		};
		if (isReview) {
			signals.approved = true;
		}

		return {
			status: "success",
			summary: `Completed: ${task.prompt.slice(0, 80)}`,
			signals,
		};
	};
}

const definition: JobDefinition = {
	id: "interactive-demo",
	stages: [],
	dependencies: [],
};

async function main() {
	const executor = mockStreamingExecutor();
	const runner = new JobRunner(definition, executor, { concurrency: 3 });
	const tui = new TuiApp(runner, definition, { interactive: true });

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
