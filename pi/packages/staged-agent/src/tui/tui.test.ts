import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
