/**
 * Native Pi session runtime integration.
 *
 * Wraps `AgentSessionRuntime` from `@mariozechner/pi-coding-agent` to
 * provide the execution layer for the staged-agent runtime. Each task
 * attempt runs in a fresh Pi session with lineage via `parentSession`.
 */

import {
	type CreateAgentSessionRuntimeFactory,
	type AgentSessionRuntime,
	type AgentSessionEvent,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";

import { Actor, Deferred } from "./actor.js";
import type {
	TaskDefinition,
	TaskResult,
	SessionId,
} from "./types.js";

// ---------------------------------------------------------------------------
// PiSessionPool — wraps AgentSessionRuntime lifecycle
// ---------------------------------------------------------------------------

export type PiSessionPoolOpts = {
	cwd?: string;
	agentDir?: string;
	concurrency?: number;
	/** Session directory for session file persistence. */
	sessionDir?: string;
};

export type PiSessionPoolMsg =
	| { type: "acquire"; parentSession?: string; deferred: Deferred<PiSession> }
	| { type: "release"; sessionId: SessionId }
	| { type: "dispose" };

export type PiSession = {
	sessionId: SessionId;
	runtime: AgentSessionRuntime;
};

/**
 * Actor that manages a pool of Pi session runtimes.
 *
 * Each `acquire` creates (or reuses) an `AgentSessionRuntime`. The
 * runtime owns one `AgentSession` at a time. Back-pressure is enforced
 * via a concurrency limit — excess acquires queue in the mailbox.
 */
export class PiSessionPool extends Actor<PiSessionPoolMsg> {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly concurrency: number;
	private nextId = 1;
	private readonly active = new Map<SessionId, PiSession>();
	private readonly waiters: Array<{
		parentSession?: string;
		deferred: Deferred<PiSession>;
	}> = [];
	private readonly factory: CreateAgentSessionRuntimeFactory;
	private sessionManager: SessionManager | undefined;

	constructor(opts?: PiSessionPoolOpts) {
		super();
		this.cwd = opts?.cwd ?? process.cwd();
		this.agentDir = opts?.agentDir ?? getAgentDir();
		this.concurrency = opts?.concurrency ?? Infinity;

		this.factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
	}

	protected async handle(msg: PiSessionPoolMsg): Promise<void> {
		switch (msg.type) {
			case "acquire":
				await this.onAcquire(msg.parentSession, msg.deferred);
				break;
			case "release":
				await this.onRelease(msg.sessionId);
				break;
			case "dispose":
				await this.onDispose();
				break;
		}
	}

	private async onAcquire(
		parentSession: string | undefined,
		deferred: Deferred<PiSession>,
	): Promise<void> {
		if (this.active.size >= this.concurrency) {
			this.waiters.push({ parentSession, deferred });
			return;
		}
		try {
			const session = await this.createSession(parentSession);
			deferred.resolve(session);
		} catch (err) {
			deferred.reject(err);
		}
	}

	private async onRelease(sessionId: SessionId): Promise<void> {
		const session = this.active.get(sessionId);
		if (session) {
			this.active.delete(sessionId);
			try {
				await session.runtime.dispose();
			} catch { /* best-effort cleanup */ }
		}

		if (this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			try {
				const session = await this.createSession(waiter.parentSession);
				waiter.deferred.resolve(session);
			} catch (err) {
				waiter.deferred.reject(err);
			}
		}
	}

	private async onDispose(): Promise<void> {
		for (const [, session] of this.active) {
			try {
				await session.runtime.dispose();
			} catch { /* best-effort */ }
		}
		this.active.clear();

		for (const w of this.waiters) {
			w.deferred.reject(new Error("Pi session pool disposed"));
		}
		this.waiters.length = 0;
		this.stop();
	}

	private async createSession(
		parentSession?: string,
	): Promise<PiSession> {
		if (!this.sessionManager) {
			this.sessionManager = SessionManager.create(this.cwd);
		}

		const runtime = await createAgentSessionRuntime(this.factory, {
			cwd: this.cwd,
			agentDir: this.agentDir,
			sessionManager: this.sessionManager,
		});

		if (parentSession) {
			await runtime.newSession({ parentSession });
		}

		await runtime.session.bindExtensions({});

		const sessionId = `pi-session-${this.nextId++}`;
		const piSession: PiSession = { sessionId, runtime };
		this.active.set(sessionId, piSession);
		return piSession;
	}

	get activeCount(): number {
		return this.active.size;
	}
}

// ---------------------------------------------------------------------------
// createPiTaskExecutor — drives a real AgentSession to completion
// ---------------------------------------------------------------------------

export type PiTaskExecutorOpts = {
	pool: PiSessionPool;
};

/**
 * Creates a `TaskExecutor` that drives real Pi sessions.
 *
 * For each task:
 * 1. Acquires a PiSession from the pool
 * 2. Sends the task prompt via `session.prompt()`
 * 3. Subscribes to events and waits for `agent_end`
 * 4. Extracts the final assistant text as `TaskResult.summary`
 * 5. Releases the session back to the pool
 *
 * The session's transcript, tool usage, and lineage remain in Pi's
 * session storage — the staged-agent runtime stays thin.
 */
export function createPiTaskExecutor(opts: PiTaskExecutorOpts) {
	return async function piTaskExecutor(
		task: TaskDefinition,
		sessionId: SessionId,
		signal: AbortSignal,
		onProgress?: import("./types.js").TaskProgressCallback,
	): Promise<TaskResult> {
		const poolDeferred = new Deferred<PiSession>();
		opts.pool.send({ type: "acquire", deferred: poolDeferred });

		let piSession: PiSession;
		try {
			piSession = await poolDeferred.promise;
		} catch (err) {
			return {
				status: "failure",
				summary: `Failed to acquire Pi session: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		if (signal.aborted) {
			opts.pool.send({ type: "release", sessionId: piSession.sessionId });
			return { status: "failure", summary: "Task aborted before execution" };
		}

		try {
			const result = await driveSession(
				piSession.runtime,
				task,
				signal,
				onProgress,
			);
			return result;
		} finally {
			opts.pool.send({
				type: "release",
				sessionId: piSession.sessionId,
			});
		}
	};
}

async function driveSession(
	runtime: AgentSessionRuntime,
	task: TaskDefinition,
	signal: AbortSignal,
	onProgress?: import("./types.js").TaskProgressCallback,
): Promise<TaskResult> {
	const session = runtime.session;
	const done = new Deferred<TaskResult>();
	let unsubscribe: (() => void) | undefined;

	const onAbort = () => {
		session.abort();
		done.resolve({
			status: "failure",
			summary: "Task aborted",
		});
	};

	if (signal.aborted) {
		return { status: "failure", summary: "Task aborted before execution" };
	}
	signal.addEventListener("abort", onAbort, { once: true });

	// Surface the real Pi session file/cwd immediately so the task view can
	// mirror interactive-mode rendering while the task is still running.
	onProgress?.({
		kind: "status",
		text: "Attached Pi session",
		signals: {
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			cwd: session.sessionManager.getCwd(),
		},
	});

	unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "agent_end") {
			signal.removeEventListener("abort", onAbort);

			const assistantText = session.getLastAssistantText();
			const messages = event.messages;

			const signals: Record<string, unknown> = {};
			const lastAssistant = [...messages]
				.reverse()
				.find((m) => m.role === "assistant");
			if (lastAssistant && "usage" in lastAssistant) {
				signals.usage = lastAssistant.usage;
				signals.model = lastAssistant.model;
				signals.stopReason = lastAssistant.stopReason;
			}

			signals.sessionFile = session.sessionFile;
			signals.sessionId = session.sessionId;
			signals.messageCount = messages.length;

			done.resolve({
				status: "success",
				summary: assistantText ?? "(empty response)",
				signals,
			});
		}
	});

	const prompt = buildPrompt(task);

	try {
		await session.prompt(prompt);
	} catch (err) {
		signal.removeEventListener("abort", onAbort);
		unsubscribe?.();
		return {
			status: "failure",
			summary: `Pi session error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const result = await done.promise;
	unsubscribe?.();
	return result;
}

function buildPrompt(task: TaskDefinition): string {
	let prompt = task.prompt;
	if (task.context && Object.keys(task.context).length > 0) {
		prompt += `\n\nContext:\n${JSON.stringify(task.context, null, 2)}`;
	}
	return prompt;
}
