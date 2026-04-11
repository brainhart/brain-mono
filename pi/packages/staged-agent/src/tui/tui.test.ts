import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
	colored, statusIcon, statusLabel, formatDuration, horizontalRule, padRight,
	FG_RED, BOLD,
} from "./helpers.js";
import { DashboardView } from "./views/dashboard.js";
import { StageView } from "./views/stage.js";
import { TaskView } from "./views/task.js";
import { HelpView } from "./views/help.js";
import type { JobState } from "../state.js";
import type { JobDefinition } from "../types.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
	it("colored wraps text in ANSI codes", () => {
		const result = colored("hello", FG_RED, BOLD);
		assert.ok(result.includes("hello"));
		assert.ok(result.startsWith("\x1b["));
		assert.ok(result.endsWith("\x1b[0m"));
	});

	it("statusIcon returns symbols for all statuses", () => {
		for (const s of ["completed", "failed", "running", "waiting", "paused", "skipped"]) {
			const icon = statusIcon(s);
			assert.ok(stripAnsi(icon).length > 0, `icon for "${s}" should be non-empty`);
		}
	});

	it("statusLabel returns colored labels", () => {
		const label = statusLabel("running");
		assert.equal(stripAnsi(label), "running");
	});

	it("formatDuration handles milliseconds", () => {
		assert.equal(formatDuration(500), "500ms");
	});

	it("formatDuration handles seconds", () => {
		assert.equal(formatDuration(12300), "12.3s");
	});

	it("formatDuration handles minutes", () => {
		assert.equal(formatDuration(125000), "2m5s");
	});

	it("formatDuration handles hours", () => {
		assert.equal(formatDuration(3661000), "1h1m");
	});

	it("horizontalRule creates repeated chars", () => {
		assert.equal(horizontalRule(5, "-"), "-----");
	});

	it("padRight pads to given width using visibleWidth", () => {
		const result = padRight("ab", 5);
		assert.equal(visibleWidth(result), 5);
	});
});

// ---------------------------------------------------------------------------
// View tests with a mock job
// ---------------------------------------------------------------------------

function makeDefinition(): JobDefinition {
	return {
		id: "test-job",
		stages: [
			{
				id: "plan",
				name: "Planning",
				tasks: [
					{ id: "plan-t1", prompt: "Create a plan for the project" },
				],
			},
			{
				id: "impl",
				name: "Implementation",
				tasks: [
					{ id: "impl-t1", prompt: "Implement auth module" },
					{ id: "impl-t2", prompt: "Implement API layer" },
					{ id: "impl-t3", prompt: "Implement database schema" },
				],
			},
			{
				id: "review",
				name: "Review",
				tasks: [
					{ id: "review-t1", prompt: "Review implementation" },
				],
			},
		],
		dependencies: [
			{ parentStageId: "plan", childStageId: "impl" },
			{ parentStageId: "impl", childStageId: "review" },
		],
	};
}

function makeState(): JobState {
	const now = Date.now();
	return {
		jobId: "test-job",
		status: "running",
		stages: new Map([
			["plan", { stageId: "plan", status: "completed", attemptCount: 1, startedAt: now - 5000, completedAt: now - 3000 }],
			["impl", { stageId: "impl", status: "running", attemptCount: 1, startedAt: now - 3000 }],
			["review", { stageId: "review", status: "waiting", attemptCount: 0 }],
		]),
		tasks: new Map([
			["plan-t1", { taskId: "plan-t1", stageId: "plan", status: "completed", attemptCount: 1, result: { status: "success", summary: "Plan created" }, startedAt: now - 5000, completedAt: now - 3000, progressLines: [], progressEntries: [], operatorNotes: [], attempts: [{ taskAttemptId: "plan-t1:a1", attemptNumber: 1, startedAt: now - 5000, finishedAt: now - 3000, result: { status: "success", summary: "Plan created" } }] }],
			["impl-t1", { taskId: "impl-t1", stageId: "impl", status: "completed", attemptCount: 1, result: { status: "success", summary: "Auth done" }, startedAt: now - 3000, completedAt: now - 1000, progressLines: [], progressEntries: [], operatorNotes: [], attempts: [{ taskAttemptId: "impl-t1:a1", attemptNumber: 1, startedAt: now - 3000, finishedAt: now - 1000, result: { status: "success", summary: "Auth done" } }] }],
			["impl-t2", { taskId: "impl-t2", stageId: "impl", status: "running", attemptCount: 1, startedAt: now - 2000, progressLines: ["Analyzing codebase…", "⚡ read({path: \"src/api.ts\"})"], progressEntries: [{ kind: "text", text: "Analyzing codebase…" }, { kind: "tool_call", toolName: "read", toolArgs: { path: "src/api.ts" } }], operatorNotes: [{ note: "Prefer the existing API client abstraction.", action: "note", timestamp: now - 1200 }], attempts: [{ taskAttemptId: "impl-t2:a1", attemptNumber: 1, startedAt: now - 2000 }] }],
			["impl-t3", { taskId: "impl-t3", stageId: "impl", status: "failed", attemptCount: 2, error: "DB connection error", result: { status: "failure", summary: "DB connection error" }, startedAt: now - 2500, completedAt: now - 500, progressLines: [], progressEntries: [], operatorNotes: [], attempts: [{ taskAttemptId: "impl-t3:a1", attemptNumber: 1, startedAt: now - 2500, finishedAt: now - 1500, error: "timeout" }, { taskAttemptId: "impl-t3:a2", attemptNumber: 2, startedAt: now - 1500, finishedAt: now - 500, error: "DB connection error" }] }],
		]),
		stageResults: new Map(),
		transitions: [],
		tokenUsage: { inputTokens: 5000, outputTokens: 2000, totalTokens: 7000 },
	};
}

describe("DashboardView", () => {
	it("renders stage list with status icons", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		view.setState(makeState());
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Planning"), "should contain stage name");
		assert.ok(plain.includes("Implementation"), "should contain stage name");
		assert.ok(plain.includes("Review"), "should contain stage name");
		assert.ok(plain.includes("NORMAL"), "should show mode indicator in footer");
	});

	it("emits drill_stage action via onAction callback", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);

		view.handleInput("\x1b[B"); // down arrow
		view.handleInput("\r");     // enter
		assert.ok(actions.includes("drill_stage"));
	});

	it("emits quit action on q", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("q");
		assert.deepEqual(actions, ["quit"]);
	});

	it("emits pause action on p", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("p");
		assert.deepEqual(actions, ["pause"]);
	});

	it("emits help action on ?", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("?");
		assert.deepEqual(actions, ["help"]);
	});

	it("keeps selected stage rows within terminal width", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		view.setState(makeState());
		const lines = view.render(80);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 80, `line exceeds width: ${stripAnsi(line)}`);
		}
	});
});

describe("StageView", () => {
	it("renders task list for a stage", () => {
		const def = makeDefinition();
		const stageDef = def.stages[1]; // impl
		const view = new StageView("impl", stageDef);
		view.setState(makeState());
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Implementation"), "should show stage name");
		assert.ok(plain.includes("impl-t1"), "should list task");
		assert.ok(plain.includes("impl-t2"), "should list task");
		assert.ok(plain.includes("impl-t3"), "should list task");
	});

	it("emits back on escape", () => {
		const view = new StageView("impl", makeDefinition().stages[1]);
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("\x1b"); // escape
		assert.deepEqual(actions, ["back"]);
	});

	it("emits drill_task via enter", () => {
		const def = makeDefinition();
		const view = new StageView("impl", def.stages[1]);
		view.setState(makeState());
		const actions: Array<{ type: string }> = [];
		view.onAction = (a) => actions.push(a);
		view.handleInput("\x1b[B"); // down
		view.handleInput("\r");      // enter
		const drill = actions.find((a) => a.type === "drill_task");
		assert.ok(drill);
	});

	it("keeps selected task rows within terminal width", () => {
		const def = makeDefinition();
		const view = new StageView("impl", def.stages[1]);
		view.setState(makeState());
		const lines = view.render(80);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 80, `line exceeds width: ${stripAnsi(line)}`);
		}
	});
});

describe("TaskView", () => {
	it("renders task detail with prompt", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0]; // impl-t1
		const view = new TaskView("impl-t1", taskDef);
		view.setState(makeState());
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("impl-t1"), "should show task id");
		assert.ok(plain.includes("Implement auth module"), "should show prompt");
		assert.ok(plain.includes("Auth done"), "should show result summary");
	});

	it("renders running task without result", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[1]; // impl-t2
		const view = new TaskView("impl-t2", taskDef);
		view.setState(makeState());
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("running"), "should show running status");
		assert.ok(plain.includes("Live output"), "should show streaming progress");
		assert.ok(plain.includes("Operator notes"), "should show operator notes section");
		assert.ok(plain.includes("Prefer the existing API client abstraction."), "should render note content");
	});

	it("prefers inline Pi session log over custom live output when transcript is available", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[1];
		const view = new TaskView("impl-t2", taskDef);
		view.setState(makeState());
		view.setTranscriptEntries([
			{
				role: "assistant",
				content: [{ type: "text", text: "Inspecting the API layer." }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			} satisfies AssistantMessage,
		], "pi-session-7", "/tmp");

		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Pi session log"));
		assert.ok(!plain.includes("Live output"));
		assert.ok(plain.includes("Inspecting the API layer."));
	});

	it("emits back on escape", () => {
		const view = new TaskView("t1", { id: "t1", prompt: "test" });
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("\x1b"); // escape
		assert.deepEqual(actions, ["back"]);
	});

	it("opens task actions on alt-a", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[1];
		const view = new TaskView("impl-t2", taskDef);
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("\x1ba");
		assert.deepEqual(actions, ["open_actions"]);
	});

	it("shows the runtime session id when available", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0];
		const view = new TaskView("impl-t1", taskDef);
		const state = makeState();
		const task = state.tasks.get("impl-t1");
		assert.ok(task);
		task.sessionId = "session-1";
		task.result = {
			status: "success",
			summary: "Auth done",
			signals: {
				sessionId: "pi-session-7",
				sessionFile: "/tmp/pi-session-7.json",
			},
		};
		view.setState(state);

		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("session: pi-session-7"));
		assert.ok(!plain.includes("session: session-1"));
	});

	it("only opens transcript when a session file exists", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0];
		const view = new TaskView("impl-t1", taskDef);
		const state = makeState();
		const task = state.tasks.get("impl-t1");
		assert.ok(task);

		task.result = {
			status: "success",
			summary: "Auth done",
			signals: {
				sessionId: "pi-session-7",
			},
		};
		view.setState(state);

		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("t");
		assert.deepEqual(actions, []);

		task.result = {
			status: "success",
			summary: "Auth done",
			signals: {
				sessionId: "pi-session-7",
				sessionFile: "/tmp/pi-session-7.json",
			},
		};
		view.handleInput("t");
		assert.deepEqual(actions, ["view_transcript"]);
	});

	it("wraps long signal values to terminal width", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0];
		const view = new TaskView("impl-t1", taskDef, "Job → What is going on in this directory? → impl-t1");
		const state = makeState();
		const task = state.tasks.get("impl-t1");
		assert.ok(task);
		task.result = {
			status: "success",
			summary: "Auth done",
			signals: {
				sessionId: "pi-session-7",
				sessionFile: "/Users/brianhart/.pi/agent/sessions/very/deeply/nested/project/path/with/a/long/component/name/that/can/exceed/the/terminal/width/session-1.jsonl",
				usage: {
					inputTokens: 100,
					outputTokens: 50,
					nested: {
						cwd: "/workspace/pi/packages/staged-agent",
					},
				},
			},
		};
		view.setState(state);

		const lines = view.render(122);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 122, `line exceeds width: ${stripAnsi(line)}`);
		}
	});

	it("renders inline session transcript entries", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0];
		const view = new TaskView("impl-t1", taskDef);
		view.setState(makeState());
		view.setTranscriptEntries([
			{
				role: "user",
				content: "Inspect this directory thoroughly.",
				timestamp: Date.now(),
			} satisfies UserMessage,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "It is a TypeScript package with a staged TUI workflow." },
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			} satisfies AssistantMessage,
		], "pi-session-7", "/workspace/pi/packages/staged-agent");

		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Pi session log"));
		assert.ok(plain.includes("Inspect this directory thoroughly."));
		assert.ok(plain.includes("TypeScript package with a staged TUI workflow."));
	});

	it("scrolls to the latest bottom after transcript content grows", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[1];
		const view = new TaskView("impl-t2", taskDef);
		const state = makeState();
		const task = state.tasks.get("impl-t2");
		assert.ok(task);
		task.progressEntries = [];
		task.progressLines = [];
		view.setState(state);

		// Seed the internal scroll bounds with the shorter pre-transcript layout.
		view.render(80);
		view.setTranscriptEntries(
			Array.from({ length: 80 }, (_, index) => ({
				role: "user",
				content: `transcript line ${index}`,
				timestamp: Date.now() + index,
			} satisfies UserMessage)),
			"pi-session-7",
			"/tmp",
		);

		const oldContentHeight = (view as any).contentHeight as number;
		view.handleInput("G");
		view.render(80);
		assert.ok(
			(view as any).scrollOffset > oldContentHeight,
			"bottom navigation should use the expanded layout instead of the stale pre-growth height",
		);
	});

	it("renders tool executions using interactive transcript components", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0];
		const view = new TaskView("impl-t1", taskDef);
		view.setState(makeState());
		view.setTranscriptEntries([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "src/api.ts" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			} satisfies AssistantMessage,
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "Found 42 lines in src/api.ts" }],
				isError: false,
				timestamp: Date.now(),
			} satisfies ToolResultMessage,
		], "pi-session-7", "/workspace/pi/packages/staged-agent");

		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("read"));
		assert.ok(plain.includes("Found 42 lines in src/api.ts"));
	});

	it("renders orphaned tool results instead of dropping them", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0];
		const view = new TaskView("impl-t1", taskDef);
		view.setState(makeState());
		view.setTranscriptEntries([
			{
				role: "toolResult",
				toolCallId: "missing-call",
				toolName: "read",
				content: [{ type: "text", text: "Recovered orphaned tool result" }],
				isError: false,
				timestamp: Date.now(),
			} satisfies ToolResultMessage,
		], "pi-session-7", "/workspace/pi/packages/staged-agent");

		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("read"));
		assert.ok(plain.includes("Recovered orphaned tool result"));
	});
});

describe("HelpView", () => {
	it("renders keybinding list", () => {
		const view = new HelpView();
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Keybindings"), "should have title");
		assert.ok(plain.includes("/ l"), "should list enter/l key");
		assert.ok(plain.includes("Drill into"), "should describe drill action");
		assert.ok(plain.includes("Alt-a"), "should show task actions shortcut");
	});

	it("emits close on escape", () => {
		const view = new HelpView();
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("\x1b"); // escape
		assert.deepEqual(actions, ["close"]);
	});

	it("emits close on ?", () => {
		const view = new HelpView();
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("?");
		assert.deepEqual(actions, ["close"]);
	});

	it("emits quit on q (not just close)", () => {
		const view = new HelpView();
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("q");
		assert.deepEqual(actions, ["quit"]);
	});

	it("describes quit as exiting after work drains", () => {
		const view = new HelpView();
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Quit / finish current session"));
	});
});

// ---------------------------------------------------------------------------
// EventLog.subscribe integration
// ---------------------------------------------------------------------------

describe("EventLog.subscribe", () => {
	it("notifies subscribers on append", async () => {
		const { EventLog } = await import("../event-log.js");
		const log = new EventLog();
		const received: string[] = [];
		log.subscribe((e) => received.push(e.type));
		log.append({
			type: "job_submitted",
			jobId: "j1",
			stageIds: ["s1"],
			timestamp: 1,
		});
		log.append({
			type: "job_completed",
			jobId: "j1",
			timestamp: 2,
		});
		assert.deepEqual(received, ["job_submitted", "job_completed"]);
		log.close();
	});

	it("unsubscribe stops notifications", async () => {
		const { EventLog } = await import("../event-log.js");
		const log = new EventLog();
		const received: string[] = [];
		const unsub = log.subscribe((e) => received.push(e.type));
		log.append({ type: "job_submitted", jobId: "j1", stageIds: [], timestamp: 1 });
		unsub();
		log.append({ type: "job_completed", jobId: "j1", timestamp: 2 });
		assert.deepEqual(received, ["job_submitted"]);
		log.close();
	});

	it("subscriber errors do not break the log", async () => {
		const { EventLog } = await import("../event-log.js");
		const log = new EventLog();
		log.subscribe(() => { throw new Error("boom"); });
		log.append({ type: "job_submitted", jobId: "j1", stageIds: [], timestamp: 1 });
		assert.equal(log.getEvents().length, 1);
		log.close();
	});
});

// ---------------------------------------------------------------------------
// Hardening tests
// ---------------------------------------------------------------------------

describe("EventLogView edge cases", () => {
	it("handles scroll with zero events", async () => {
		const { EventLogView } = await import("./views/event-log.js");
		const view = new EventLogView();
		view.setEvents([]);

		view.handleInput("\x1b[B"); // down arrow with 0 events
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("No events yet"));
	});
});

describe("TuiApp hardening", () => {
	it("resolves transcript paths relative to cwd", async () => {
		const { EventLog } = await import("../event-log.js");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "staged-agent-tui-"));
		const sessionPath = path.join(tmpDir, "session.jsonl");

		const capturedPaths: string[] = [];
		const originalOpen = (await import("@mariozechner/pi-coding-agent")).SessionManager.open;
		(await import("@mariozechner/pi-coding-agent")).SessionManager.open = ((p: string) => {
			capturedPaths.push(p);
			return {
				getCwd: () => tmpDir,
				buildSessionContext: () => ({ messages: [] }),
			};
		}) as unknown as typeof originalOpen;

		try {
			const runner = {
				jobId: "j1",
				getEventLog: () => new EventLog(),
			} as unknown as import("../job-runner.js").JobRunner;
			const app = new (await import("./app.js")).TuiApp(runner, makeDefinition(), { cwd: tmpDir });

			await (app as any).loadTranscript("session.jsonl");
			assert.deepEqual(capturedPaths, [sessionPath]);
		} finally {
			(await import("@mariozechner/pi-coding-agent")).SessionManager.open = originalOpen;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("hydrates inline transcript on task drill-down", async () => {
		const { EventLog } = await import("../event-log.js");
		const runner = {
			jobId: "j1",
			getEventLog: () => new EventLog(),
		} as unknown as import("../job-runner.js").JobRunner;
		const app = new (await import("./app.js")).TuiApp(runner, makeDefinition(), { cwd: "/tmp" });

		const entries = [
			{
				role: "assistant",
				content: [{ type: "text", text: "Loaded transcript entry" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			} satisfies AssistantMessage,
		];
		(app as any).loadTranscript = async () => ({ entries, cwd: "/tmp" });
		(app as any).state = makeState();
		const task = (app as any).state.tasks.get("impl-t1");
		assert.ok(task);
		task.result = {
			status: "success",
			summary: "Auth done",
			signals: {
				sessionId: "pi-session-7",
				sessionFile: "/tmp/pi-session-7.json",
			},
		};
		(app as any).started = true;

		const view = new TaskView("impl-t1", makeDefinition().stages[1].tasks[0]);
		view.setState((app as any).state);

		(app as any).maybeLoadInlineTranscript(view, "impl-t1");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const plain = stripAnsi(view.render(80).join("\n"));
		assert.ok(plain.includes("Pi session log"));
		assert.ok(plain.includes("Loaded transcript entry"));
	});

	it("refreshes inline task transcripts on timer ticks", async () => {
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		let intervalCallback: (() => void) | undefined;

		globalThis.setInterval = (((callback: TimerHandler) => {
			intervalCallback = callback as () => void;
			return { ref: () => undefined, unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
		}) as unknown) as typeof setInterval;
		globalThis.clearInterval = (() => undefined) as typeof clearInterval;

		try {
			const log = {
				subscribe: () => () => undefined,
				getEvents: () => [],
			};
			const runner = {
				jobId: "j1",
				getEventLog: () => log,
			} as unknown as import("../job-runner.js").JobRunner;
			const app = new (await import("./app.js")).TuiApp(runner, makeDefinition(), { cwd: "/tmp" });
			const view = new TaskView("impl-t1", makeDefinition().stages[1].tasks[0]);

			(app as any).viewStack = [{ type: "task", view, taskId: "impl-t1" }];
			(app as any).tui.clear = () => undefined;
			(app as any).tui.addChild = () => undefined;
			(app as any).tui.setFocus = () => undefined;
			(app as any).tui.start = () => undefined;
			(app as any).tui.stop = () => undefined;

			let refreshCount = 0;
			(app as any).refreshLiveViews = () => {
				refreshCount++;
			};

			app.start();
			assert.ok(intervalCallback, "expected start() to install a render timer");

			intervalCallback?.();
			assert.equal(refreshCount, 1, "timer tick should refresh live views before requesting a render");

			app.stop();
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});
});

describe("projectState hardening", () => {
	it("aggregates token usage from signals.usage", async () => {
		const { projectState } = await import("../state.js");
		const events = [
			{ type: "job_submitted" as const, jobId: "j", stageIds: ["s"], timestamp: 1 },
			{ type: "stage_submitted" as const, jobId: "j", stageId: "s", timestamp: 2 },
			{ type: "task_started" as const, jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:1", stageAttemptId: "s:1", attemptNumber: 1, timestamp: 3 },
			{ type: "task_completed" as const, jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:1", result: { status: "success" as const, summary: "ok", signals: { usage: { inputTokens: 100, outputTokens: 50 } } }, timestamp: 4 },
		];
		const state = projectState(events);
		assert.equal(state.tokenUsage.inputTokens, 100);
		assert.equal(state.tokenUsage.outputTokens, 50);
		assert.equal(state.tokenUsage.totalTokens, 150);
	});

	it("handles malformed usage gracefully", async () => {
		const { projectState } = await import("../state.js");
		const events = [
			{ type: "job_submitted" as const, jobId: "j", stageIds: ["s"], timestamp: 1 },
			{ type: "task_started" as const, jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:1", stageAttemptId: "s:1", attemptNumber: 1, timestamp: 2 },
			{ type: "task_completed" as const, jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:1", result: { status: "success" as const, summary: "ok", signals: { usage: "not-an-object" } }, timestamp: 3 },
		];
		const state = projectState(events);
		assert.equal(state.tokenUsage.totalTokens, 0);
	});

	it("tracks progress ring buffer", async () => {
		const { projectState } = await import("../state.js");
		const events: import("../events.js").RuntimeEvent[] = [
			{ type: "job_submitted", jobId: "j", stageIds: ["s"], timestamp: 1 },
			{ type: "task_started", jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:1", stageAttemptId: "s:1", attemptNumber: 1, timestamp: 2 },
		];
		for (let i = 0; i < 60; i++) {
			events.push({ type: "task_progress", jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:1", progress: { kind: "text", text: `line ${i}` }, timestamp: 3 + i });
		}
		const state = projectState(events);
		const ts = state.tasks.get("t")!;
		assert.equal(ts.progressLines.length, 50);
		assert.ok(ts.progressLines[0].includes("line 10"));
	});

	it("clears stale result and adopts live session signals on retries", async () => {
		const { projectState } = await import("../state.js");
		const events: import("../events.js").RuntimeEvent[] = [
			{ type: "job_submitted", jobId: "j", stageIds: ["s"], timestamp: 1 },
			{ type: "task_started", jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:1", stageAttemptId: "s:1", attemptNumber: 1, timestamp: 2 },
			{
				type: "task_completed",
				jobId: "j",
				stageId: "s",
				taskId: "t",
				taskAttemptId: "t:1",
				result: {
					status: "success",
					summary: "old result",
					signals: { sessionFile: "/tmp/old.jsonl", sessionId: "old-session" },
				},
				timestamp: 3,
			},
			{ type: "task_started", jobId: "j", stageId: "s", taskId: "t", taskAttemptId: "t:2", stageAttemptId: "s:2", attemptNumber: 2, timestamp: 4 },
			{
				type: "task_progress",
				jobId: "j",
				stageId: "s",
				taskId: "t",
				taskAttemptId: "t:2",
				progress: {
					kind: "status",
					text: "Attached Pi session",
					signals: {
						sessionFile: "/tmp/new.jsonl",
						sessionId: "pi-session-2",
						sessionCwd: "/workspace/pi/packages/staged-agent",
					},
				},
				timestamp: 5,
			},
		];
		const state = projectState(events);
		const task = state.tasks.get("t");
		assert.ok(task);
		assert.equal(task.status, "running");
		assert.equal(task.result, undefined);
		assert.equal(task.sessionFile, "/tmp/new.jsonl");
		assert.equal(task.sessionId, "pi-session-2");
		assert.equal(task.sessionCwd, "/workspace/pi/packages/staged-agent");
	});

	it("tracks pause reason and resume input", async () => {
		const { projectState } = await import("../state.js");
		type RE = import("../events.js").RuntimeEvent;
		const events: RE[] = [
			{ type: "job_submitted", jobId: "j", stageIds: ["s"], timestamp: 1 },
			{ type: "job_paused", jobId: "j", reason: "needs approval", timestamp: 2 },
		];
		let state = projectState(events);
		assert.equal(state.pauseReason, "needs approval");
		assert.equal(state.status, "paused");

		events.push({ type: "job_resumed", jobId: "j", input: "approved", timestamp: 3 });
		state = projectState(events);
		assert.equal(state.lastResumeInput, "approved");
		assert.equal(state.pauseReason, undefined);
		assert.equal(state.status, "running");
	});

	it("handles task_completed without prior task_started", async () => {
		const { projectState } = await import("../state.js");
		const events = [
			{ type: "job_submitted" as const, jobId: "j", stageIds: ["s"], timestamp: 1 },
			{ type: "task_completed" as const, jobId: "j", stageId: "s", taskId: "orphan", taskAttemptId: "o:1", result: { status: "success" as const, summary: "ok" }, timestamp: 2 },
		];
		const state = projectState(events);
		assert.equal(state.tasks.has("orphan"), false);
		assert.ok(state.stageResults.get("s"));
	});
});

describe("parseNavKey with KeyState", () => {
	it("gg sequence returns top", async () => {
		const { parseNavKey, KeyState } = await import("./keybindings.js");
		const state = new KeyState();
		assert.equal(parseNavKey("g", state), undefined);
		assert.ok(state.pendingG);
		assert.deepEqual(parseNavKey("g", state), { type: "top" });
		assert.ok(!state.pendingG);
	});

	it("g then non-g falls through to normal key parsing", async () => {
		const { parseNavKey, KeyState } = await import("./keybindings.js");
		const state = new KeyState();
		parseNavKey("g", state);
		const result = parseNavKey("j", state);
		assert.deepEqual(result, { type: "down" }, "j should not be swallowed after g");
	});

	it("separate KeyState instances are independent", async () => {
		const { parseNavKey, KeyState } = await import("./keybindings.js");
		const s1 = new KeyState();
		const s2 = new KeyState();
		parseNavKey("g", s1);
		assert.ok(s1.pendingG);
		assert.ok(!s2.pendingG);
		assert.deepEqual(parseNavKey("j", s2), { type: "down" });
	});
});

describe("StageActor predicate safety", () => {
	it("handles throwing predicate fn without crashing", async () => {
		const { StageActor } = await import("../stage-actor.js");
		const { EventLog } = await import("../event-log.js");
		const { Deferred } = await import("../actor.js");

		const log = new EventLog();
		const parentMessages: Array<{ type: string }> = [];
		const parentRef = {
			send: (msg: { type: string }) => parentMessages.push(msg),
		};
		const poolRef = {
			send: (_msg: unknown) => {},
		};

		const throwingPolicy = {
			type: "predicate" as const,
			fn: () => { throw new Error("kaboom"); },
		};

		const actor = new StageActor(
			"s1", "s1:attempt:1", "j1",
			[{ id: "t1", prompt: "test" }],
			async (_task, _sid, _signal) => ({ status: "success" as const, summary: "ok" }),
			poolRef as any,
			parentRef as any,
			log,
			{ completionPolicy: throwingPolicy },
		);

		const sessionDeferred = new Deferred<string>();
		poolRef.send = (msg: any) => {
			if (msg.type === "acquire") {
				msg.deferred.resolve("ses-1");
			}
		};

		actor.send({ type: "run" });
		await new Promise((r) => setTimeout(r, 100));

		const hasResponse = parentMessages.some(m => m.type === "stage_completed" || m.type === "stage_failed");
		assert.ok(hasResponse, "StageActor should report completion even with throwing predicate");
		log.close();
	});
});
