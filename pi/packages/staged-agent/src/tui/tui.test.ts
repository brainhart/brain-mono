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
	return {
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
		assert.ok(plain.includes("navigate"), "should show footer");
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

	it("renders pending task without result", () => {
		const def = makeDefinition();
		const taskDef = def.stages[1].tasks[1]; // impl-t2
		const view = new TaskView("impl-t2", taskDef);
		view.setState(makeState());
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("pending"), "should show pending");
	});

	it("emits back on escape", () => {
		const view = new TaskView("t1", { id: "t1", prompt: "test" });
		view.setState(makeState());
		const actions: string[] = [];
		view.onAction = (a) => actions.push(a.type);
		view.handleInput("\x1b"); // escape
		assert.deepEqual(actions, ["back"]);
	});
});

describe("HelpView", () => {
	it("renders keybinding list", () => {
		const view = new HelpView();
		const output = view.render(80).join("\n");
		const plain = stripAnsi(output);
		assert.ok(plain.includes("Keybindings"), "should have title");
		assert.ok(plain.includes("enter"), "should list enter key");
		assert.ok(plain.includes("Drill into"), "should describe enter");
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
