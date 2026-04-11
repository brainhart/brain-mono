#!/usr/bin/env node

import process from "node:process";
import { JobRunner } from "./job-runner.js";
import { PiSessionPool, createPiTaskExecutor } from "./pi-runtime.js";
import type { JobDefinition } from "./types.js";
import { TuiApp } from "./tui/app.js";

const definition: JobDefinition = {
	id: "interactive",
	stages: [],
	dependencies: [],
};

function printHelp(): void {
	process.stdout.write(
		[
			"staged-agent",
			"",
			"Interactive staged-agent TUI backed by the native Pi session runtime.",
			"",
			"Usage:",
			"  staged-agent",
			"  staged-agent --help",
			"",
			"Environment:",
			"  STAGED_AGENT_CONCURRENCY   Max concurrent Pi sessions (default: 3)",
			"",
			"Controls:",
			"  q                        Exit the TUI after active work drains",
		].join("\n") + "\n",
	);
}

function parseConcurrency(rawValue: string | undefined): number {
	if (!rawValue) return 3;
	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid STAGED_AGENT_CONCURRENCY value: ${rawValue}`);
	}
	return parsed;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		return;
	}
	if (args.length > 0) {
		throw new Error(`Unknown arguments: ${args.join(" ")}`);
	}

	const concurrency = parseConcurrency(process.env.STAGED_AGENT_CONCURRENCY);
	const pool = new PiSessionPool({
		cwd: process.cwd(),
		concurrency,
	});
	const executor = createPiTaskExecutor({ pool });
	const runner = new JobRunner(definition, executor, {
		concurrency,
		interactive: true,
	});

	let quitRequested = false;
	const tui = new TuiApp(runner, definition, {
		interactive: true,
		onQuit: () => {
			quitRequested = true;
			runner.finish();
		},
	});

	const onSignal = () => {
		if (quitRequested) return;
		quitRequested = true;
		tui.stop();
		runner.cancel();
	};

	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	tui.start();

	try {
		const result = await runner.run();
		tui.stop();

		if (result.status === "failed" && !quitRequested) {
			throw new Error(result.error ?? "Job failed");
		}
	} finally {
		process.removeListener("SIGINT", onSignal);
		process.removeListener("SIGTERM", onSignal);
		pool.send({ type: "dispose" });
	}
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`staged-agent: ${message}\n`);
	process.exitCode = 1;
});
