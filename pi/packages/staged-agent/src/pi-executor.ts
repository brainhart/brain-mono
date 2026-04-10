import { spawn } from "node:child_process";
import type { TaskDefinition, TaskResult, SessionId } from "./types.js";

export type PiExecutorOpts = {
	piBinary: string;
	provider?: string;
	model?: string;
	cwd?: string;
	env?: Record<string, string>;
	extraArgs?: string[];
};

type PiAgentEndEvent = {
	type: "agent_end";
	messages: Array<{
		role: string;
		content: Array<{ type: string; text?: string }>;
	}>;
};

/**
 * A `TaskExecutor` implementation that runs each task as a `pi --print`
 * invocation. The task's prompt becomes the pi prompt. The final
 * assistant text response becomes the TaskResult summary.
 *
 * Each invocation is a fresh, ephemeral pi session (`--no-session`).
 */
export function createPiExecutor(opts: PiExecutorOpts) {
	return async function piExecutor(
		task: TaskDefinition,
		_sessionId: SessionId,
		signal: AbortSignal,
	): Promise<TaskResult> {
		const args = [
			"--print",
			"--mode", "json",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
		];

		if (opts.provider) args.push("--provider", opts.provider);
		if (opts.model) args.push("--model", opts.model);
		if (opts.extraArgs) args.push(...opts.extraArgs);

		const prompt = buildPrompt(task);
		args.push(prompt);

		const result = await runPi(opts.piBinary, args, {
			cwd: opts.cwd,
			env: opts.env,
			signal,
		});

		return result;
	};
}

function buildPrompt(task: TaskDefinition): string {
	let prompt = task.prompt;
	if (task.context && Object.keys(task.context).length > 0) {
		prompt += `\n\nContext:\n${JSON.stringify(task.context, null, 2)}`;
	}
	return prompt;
}

function runPi(
	binary: string,
	args: string[],
	opts: { cwd?: string; env?: Record<string, string>; signal: AbortSignal },
): Promise<TaskResult> {
	return new Promise((resolve, reject) => {
		if (opts.signal.aborted) {
			reject(new Error("Aborted before start"));
			return;
		}

		const proc = spawn(binary, args, {
			cwd: opts.cwd ?? process.cwd(),
			env: { ...process.env, ...opts.env, PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const onAbort = () => {
			proc.kill("SIGTERM");
		};
		opts.signal.addEventListener("abort", onAbort, { once: true });

		proc.on("close", (code) => {
			opts.signal.removeEventListener("abort", onAbort);

			if (opts.signal.aborted) {
				reject(new Error("Task aborted"));
				return;
			}

			if (code !== 0) {
				resolve({
					status: "failure",
					summary: `pi exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
				});
				return;
			}

			try {
				const result = parseAgentOutput(stdout);
				resolve(result);
			} catch (err) {
				resolve({
					status: "failure",
					summary:
						err instanceof Error
							? err.message
							: `Failed to parse pi output: ${String(err)}`,
				});
			}
		});

		proc.on("error", (err) => {
			opts.signal.removeEventListener("abort", onAbort);
			reject(err);
		});

		proc.stdin.end();
	});
}

function parseAgentOutput(stdout: string): TaskResult {
	const lines = stdout.trim().split("\n");
	let agentEnd: PiAgentEndEvent | undefined;

	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const parsed = JSON.parse(lines[i]);
			if (parsed.type === "agent_end" && Array.isArray(parsed.messages)) {
				agentEnd = parsed as PiAgentEndEvent;
				break;
			}
		} catch {
			continue;
		}
	}

	if (!agentEnd) {
		return {
			status: "failure",
			summary: "No agent_end event in pi output",
		};
	}

	const assistantMessages = agentEnd.messages.filter(
		(m) => m.role === "assistant",
	);
	const lastAssistant = assistantMessages[assistantMessages.length - 1];
	if (!lastAssistant) {
		return {
			status: "failure",
			summary: "No assistant message in pi output",
		};
	}

	const textParts = lastAssistant.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");

	return {
		status: "success",
		summary: textParts || "(empty response)",
	};
}
