import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colored, fg, style, stripAnsi } from "./ansi.js";
import { statusIcon, statusLabel } from "./symbols.js";
import { formatDuration, truncate, padRight, padLeft, wrapText, horizontalRule } from "./format.js";
import { DashboardView } from "./views/dashboard.js";
import { StageView } from "./views/stage.js";
import { TaskView } from "./views/task.js";
import { HelpView } from "./views/help.js";
import type { JobState } from "../state.js";
import type { JobDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

describe("ansi", () => {
	it("colored wraps text in ANSI codes", () => {
		const result = colored("hello", fg.red, style.bold);
		assert.ok(result.includes("hello"));
		assert.ok(result.startsWith("\x1b["));
		assert.ok(result.endsWith("\x1b[0m"));
	});

	it("stripAnsi removes escape codes", () => {
		const raw = colored("test", fg.green);
		assert.equal(stripAnsi(raw), "test");
	});
});

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

describe("symbols", () => {
	it("statusIcon returns colored symbols for all statuses", () => {
		for (const s of ["completed", "failed", "running", "waiting", "paused", "skipped"]) {
			const icon = statusIcon(s);
			assert.ok(stripAnsi(icon).length > 0, `icon for "${s}" should be non-empty`);
		}
	});

	it("statusLabel returns colored labels", () => {
		const label = statusLabel("running");
		assert.equal(stripAnsi(label), "running");
	});
});

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

describe("format", () => {
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

	it("truncate shortens long text", () => {
		assert.equal(truncate("hello world", 5), "hell…");
	});

	it("truncate leaves short text unchanged", () => {
		assert.equal(truncate("hi", 5), "hi");
	});

	it("padRight pads to given width", () => {
		assert.equal(padRight("ab", 5), "ab   ");
	});

	it("padLeft pads to given width", () => {
		assert.equal(padLeft("ab", 5), "   ab");
	});

	it("wrapText splits long lines", () => {
		const wrapped = wrapText("a".repeat(20), 10);
		assert.equal(wrapped.length, 2);
		assert.equal(wrapped[0].length, 10);
		assert.equal(wrapped[1].length, 10);
	});

	it("horizontalRule creates repeated chars", () => {
		assert.equal(horizontalRule(5, "-"), "-----");
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

function makeState(overrides?: Partial<JobState>): JobState {
	const base: JobState = {
		jobId: "test-job",
		status: "running",
		stages: new Map([
			["plan", { stageId: "plan", status: "completed", attemptCount: 1 }],
			["impl", { stageId: "impl", status: "running", attemptCount: 1 }],
			["review", { stageId: "review", status: "waiting", attemptCount: 0 }],
		]),
		tasks: new Map([
			["plan-t1", { taskId: "plan-t1", stageId: "plan", status: "completed", attemptCount: 1, result: { status: "success", summary: "Plan created" } }],
			["impl-t1", { taskId: "impl-t1", stageId: "impl", status: "completed", attemptCount: 1, result: { status: "success", summary: "Auth done" } }],
			["impl-t2", { taskId: "impl-t2", stageId: "impl", status: "running", attemptCount: 1 }],
			["impl-t3", { taskId: "impl-t3", stageId: "impl", status: "failed", attemptCount: 2, result: { status: "failure", summary: "DB connection error" } }],
		]),
		stageResults: new Map(),
	};
	return { ...base, ...overrides };
}

describe("DashboardView", () => {
	it("renders stage list with status icons", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		const state = makeState();
		const output = view.render(state, 80, 24, Date.now() - 5000);
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Planning"), "should contain stage name");
		assert.ok(plain.includes("Implementation"), "should contain stage name");
		assert.ok(plain.includes("Review"), "should contain stage name");
		assert.ok(plain.includes("navigate"), "should show footer");
	});

	it("handles up/down navigation", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);

		let action = view.handleInput({ type: "down" });
		assert.equal(action, undefined);

		action = view.handleInput({ type: "enter" });
		assert.ok(action);
		assert.equal(action.type, "drill_stage");
		if (action.type === "drill_stage") {
			assert.equal(action.stageId, "impl");
		}
	});

	it("returns quit action on q", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		const action = view.handleInput({ type: "char", char: "q" });
		assert.deepEqual(action, { type: "quit" });
	});

	it("returns pause action on p", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		const action = view.handleInput({ type: "char", char: "p" });
		assert.deepEqual(action, { type: "pause" });
	});

	it("returns cancel action on c", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		const action = view.handleInput({ type: "char", char: "c" });
		assert.deepEqual(action, { type: "cancel" });
	});

	it("returns help action on ?", () => {
		const def = makeDefinition();
		const view = new DashboardView(def);
		const action = view.handleInput({ type: "char", char: "?" });
		assert.deepEqual(action, { type: "help" });
	});
});

describe("StageView", () => {
	it("renders task list for a stage", () => {
		const def = makeDefinition();
		const stageDef = def.stages[1]; // impl
		const view = new StageView("impl", stageDef);
		const state = makeState();
		const output = view.render(state, 80, 24);
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Implementation"), "should show stage name");
		assert.ok(plain.includes("impl-t1"), "should list task");
		assert.ok(plain.includes("impl-t2"), "should list task");
		assert.ok(plain.includes("impl-t3"), "should list task");
	});

	it("navigates up/down and drills into tasks", () => {
		const def = makeDefinition();
		const view = new StageView("impl", def.stages[1]);

		view.handleInput({ type: "down" });
		const action = view.handleInput({ type: "enter" });
		assert.ok(action);
		assert.equal(action.type, "drill_task");
		if (action.type === "drill_task") {
			assert.equal(action.taskId, "impl-t2");
		}
	});

	it("returns back on escape", () => {
		const view = new StageView("impl", makeDefinition().stages[1]);
		const action = view.handleInput({ type: "escape" });
		assert.deepEqual(action, { type: "back" });
	});
});

describe("TaskView", () => {
	it("renders task detail with prompt", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[0]; // impl-t1
		const view = new TaskView("impl-t1", taskDef);
		const state = makeState();
		const output = view.render(state, 80, 30);
		const plain = stripAnsi(output);
		assert.ok(plain.includes("impl-t1"), "should show task id");
		assert.ok(plain.includes("Implement auth module"), "should show prompt");
		assert.ok(plain.includes("Auth done"), "should show result summary");
	});

	it("renders pending task without result", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[1]; // impl-t2
		const view = new TaskView("impl-t2", taskDef);
		const state = makeState();
		const output = view.render(state, 80, 30);
		const plain = stripAnsi(output);
		assert.ok(plain.includes("pending"), "should show pending");
	});

	it("returns back on escape", () => {
		const view = new TaskView("t1", { id: "t1", prompt: "test" });
		const action = view.handleInput({ type: "escape" });
		assert.deepEqual(action, { type: "back" });
	});

	it("scrolls with j/k", () => {
		const view = new TaskView("t1", { id: "t1", prompt: "test" });
		let action = view.handleInput({ type: "char", char: "j" });
		assert.equal(action, undefined);
		action = view.handleInput({ type: "char", char: "k" });
		assert.equal(action, undefined);
	});
});

describe("HelpView", () => {
	it("renders keybinding list", () => {
		const view = new HelpView();
		const output = view.render(80, 24);
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Keybindings"), "should have title");
		assert.ok(plain.includes("enter"), "should list enter key");
		assert.ok(plain.includes("Drill into"), "should describe enter");
	});

	it("returns close on escape", () => {
		const view = new HelpView();
		const action = view.handleInput({ type: "escape" });
		assert.deepEqual(action, { type: "close" });
	});

	it("returns close on ?", () => {
		const view = new HelpView();
		const action = view.handleInput({ type: "char", char: "?" });
		assert.deepEqual(action, { type: "close" });
	});
});

// ---------------------------------------------------------------------------
// EventLog.subscribe integration (imported from parent)
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
