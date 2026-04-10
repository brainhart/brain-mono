/**
 * Session-based workflow orchestration
 *
 * This example translates the multi-actor workflow pattern (controller → workers
 * → reviewers, with inboxes, stores, signals, and handoff) into Pi-native
 * primitives built on top of AgentSessionRuntime.
 *
 * ────────────────────────────────────────────────────────────────────
 * Mapping from the Go workflow CLI to Pi sessions
 * ────────────────────────────────────────────────────────────────────
 *
 *   Go concept              → Pi-native equivalent
 *   ─────────────────────   ──────────────────────────────────────────
 *   workflow dir             SessionManager (manages session files on disk)
 *   actor                    AgentSession (one session = one actor turn)
 *   actor inbox (ndjson)     session entries (getEntries / appendEntry)
 *   actor store/             session file itself + custom entries
 *   message (send)           appendEntry with a typed custom entry
 *   signal                   newSession / switchSession (runtime swaps the active session)
 *   spawn (tmux pane)        runtime.newSession() — no tmux, the runtime IS the pane
 *   controller               the orchestrator code below (TypeScript, not an LLM)
 *   worker / reviewer        an AgentSession with role-specific system prompt + tools
 *   profile                  the createRuntime factory closure (captures model, tools, instructions)
 *   refs / attachments       file paths appended as custom entries in the new session
 *   handoff (store file)     custom "handoff" entry serialized into the session log
 *   wait / wait-any          subscribe() on the runtime, filtering for "done" entries
 *   check / kill             runtime.session access + dispose
 *
 * ────────────────────────────────────────────────────────────────────
 * Why sessions, not a bespoke actor system?
 * ────────────────────────────────────────────────────────────────────
 *
 * The Go gist builds a full actor runtime: inboxes, stores, tmux spawning,
 * polling, signal files. It works, but it reimplements what Pi sessions
 * already provide:
 *
 *  1. **Persistent, ordered log** — session entries are the inbox. Each entry
 *     has a type, timestamp, and payload. No ndjson files to manage.
 *
 *  2. **Session lifecycle** — runtime.newSession() / switchSession() /
 *     dispose() replace spawn / kill / check. The runtime manages one active
 *     session at a time and handles cleanup.
 *
 *  3. **Extension hooks** — session_start, turn_start, before_agent_start,
 *     session_shutdown give you the same interception points as the Go
 *     profiles' system prompts, but composable.
 *
 *  4. **Subscriptions** — session.subscribe() replaces file-system polling.
 *     You get typed events in-process instead of shelling out to `pi-workflow
 *     wait`.
 *
 *  5. **Handoff is built-in** — the existing handoff extension already
 *     demonstrates summarize-and-fork. This pattern generalizes it to N
 *     actors with structured message passing.
 *
 * The key insight: each "actor turn" is a session. The controller is regular
 * TypeScript that creates sessions, injects context, and reacts to results.
 * No tmux, no polling, no signal files.
 *
 * ────────────────────────────────────────────────────────────────────
 * Sketch of the pattern
 * ────────────────────────────────────────────────────────────────────
 *
 * The code below is a runnable but simplified skeleton. It shows the
 * essential wiring; a production version would add error handling, timeouts,
 * parallel fan-out, and richer entry types.
 */

import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────

/** A workflow message, analogous to the Go `message` struct. */
interface WorkflowMessage {
	from: string;
	to: string;
	type: string;
	payload: Record<string, unknown>;
	refs?: string[];
	ts: number;
}

/** Tracks one actor's session file and accumulated messages. */
interface ActorHandle {
	id: string;
	role: "worker" | "reviewer" | "controller";
	sessionFile: string | undefined;
	messages: WorkflowMessage[];
}

// ── Runtime factory ─────────────────────────────────────────────────

const createRuntime: CreateAgentSessionRuntimeFactory = async ({
	cwd,
	sessionManager,
	sessionStartEvent,
}) => {
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

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Send a workflow message by appending a custom entry to the recipient's
 * session. This is the Pi equivalent of `pi-workflow send`.
 */
function sendMessage(
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>,
	msg: WorkflowMessage,
) {
	const session = runtime.session;
	session.appendEntry({
		type: "custom",
		customType: "workflow-message",
		data: msg,
	});
}

/**
 * Collect all workflow messages from the current session's entries.
 * Equivalent to `loadActorState` / `readInbox` in the Go code.
 */
function getInbox(
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>,
): WorkflowMessage[] {
	const entries = runtime.session.getEntries();
	return entries
		.filter(
			(e: { type: string; customType?: string }) =>
				e.type === "custom" && e.customType === "workflow-message",
		)
		.map((e: { data: WorkflowMessage }) => e.data);
}

/**
 * Wait for a workflow-message entry of a given type to appear.
 * Replaces the Go `waitForMessage` file-polling loop with an in-process
 * subscription.
 */
function waitForMessage(
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>,
	messageType: string,
	timeoutMs = 0,
): Promise<WorkflowMessage> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const unsubscribe = runtime.session.subscribe((event) => {
			if (event.type !== "entry_added") return;
			const entry = event.entry as {
				type: string;
				customType?: string;
				data?: WorkflowMessage;
			};
			if (
				entry.type === "custom" &&
				entry.customType === "workflow-message" &&
				entry.data?.type === messageType
			) {
				unsubscribe();
				if (timer) clearTimeout(timer);
				resolve(entry.data);
			}
		});

		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for message type "${messageType}"`));
			}, timeoutMs);
		}
	});
}

// ── Orchestrator ────────────────────────────────────────────────────

/**
 * A minimal controller loop that implements the golden-path scenario from
 * the gist's TestScenario_BasicImplementReviewAdvance:
 *
 *   1. Create a worker session, send an assignment
 *   2. Wait for the worker result
 *   3. Create a reviewer session, send the review assignment + handoff
 *   4. Wait for the reviewer result
 *   5. Record advancement
 *
 * Each "actor" is a separate Pi session. The runtime.newSession() /
 * switchSession() calls are how the controller moves between them.
 */
async function runWorkflow() {
	const cwd = process.cwd();
	const sessionManager = SessionManager.create(cwd);

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir: getAgentDir(),
		sessionManager,
	});

	// The controller session — this is our "orchestrator inbox"
	const controllerSessionFile = runtime.session.sessionFile;
	console.log("Controller session:", controllerSessionFile);

	// ── Step 1: Assign work ─────────────────────────────────────────

	// Create a fresh session for the worker (equivalent to `pi-workflow spawn`)
	await runtime.newSession();
	const workerSession = runtime.session;
	console.log("Worker session:", workerSession.sessionFile);

	// Inject the assignment as a workflow message entry
	sendMessage(runtime, {
		from: "controller",
		to: "worker-01",
		type: "assignment",
		payload: {
			goal: "Implement feature X",
			checkpoint: "cp-1",
		},
		ts: Date.now(),
	});

	// In a real implementation, we'd also bind extensions and submit a
	// steering prompt here so the LLM actually runs. The session's
	// before_agent_start hook would read the workflow-message entries
	// and build the system prompt, exactly like buildSpawnPrompt() does
	// in the gist.
	//
	// await workerSession.bindExtensions({});
	// workerSession.submitSteering("Execute the assignment in your inbox.");

	// ── Step 2: Wait for result ─────────────────────────────────────

	// Simulate the worker sending a result (in reality the LLM would
	// call a tool or the session_shutdown hook would emit this).
	sendMessage(runtime, {
		from: "worker-01",
		to: "controller",
		type: "result",
		payload: {
			status: "done",
			summary: "Feature X implemented with tests",
		},
		ts: Date.now(),
	});

	// Save handoff context as a custom entry (replaces store/handoff.md)
	runtime.session.appendEntry({
		type: "custom",
		customType: "handoff",
		data: {
			actor: "worker-01",
			notes: "Implemented X in pkg/x.go\nTests in pkg/x_test.go",
			filesTouched: ["pkg/x.go", "pkg/x_test.go"],
		},
	});

	// ── Step 3: Switch to controller, review results ────────────────

	if (controllerSessionFile) {
		await runtime.switchSession(controllerSessionFile);
	}

	// Record that we received the worker result
	sendMessage(runtime, {
		from: "worker-01",
		to: "controller",
		type: "result",
		payload: {
			status: "done",
			summary: "Feature X implemented with tests",
		},
		ts: Date.now(),
	});

	// ── Step 4: Create reviewer session ─────────────────────────────

	await runtime.newSession();
	console.log("Reviewer session:", runtime.session.sessionFile);

	sendMessage(runtime, {
		from: "controller",
		to: "reviewer-01",
		type: "assignment",
		payload: {
			goal: "Review feature X implementation",
			focus: "correctness",
		},
		refs: ["pkg/x.go", "pkg/x_test.go"],
		ts: Date.now(),
	});

	// Simulate reviewer approval
	sendMessage(runtime, {
		from: "reviewer-01",
		to: "controller",
		type: "result",
		payload: {
			verdict: "approved",
			summary: "Clean implementation, good test coverage",
		},
		ts: Date.now(),
	});

	// ── Step 5: Record advancement in controller session ────────────

	if (controllerSessionFile) {
		await runtime.switchSession(controllerSessionFile);
	}

	sendMessage(runtime, {
		from: "controller",
		to: "controller",
		type: "advanced",
		payload: {
			from: "cp-1",
			to: "cp-2",
			reason: "Implementation reviewed and approved",
		},
		ts: Date.now(),
	});

	// ── Verify ──────────────────────────────────────────────────────

	const inbox = getInbox(runtime);
	console.log(
		`Controller inbox: ${inbox.length} messages`,
		inbox.map((m) => `${m.from}→${m.to} (${m.type})`),
	);

	await runtime.dispose();
}

runWorkflow().catch(console.error);
