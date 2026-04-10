/**
 * Main TUI application for observing and controlling a staged-agent job.
 *
 * Uses pi-tui's `TUI` and `ProcessTerminal` for rendering, input, and
 * terminal management. The staged-agent views are pi-tui `Component`
 * implementations that render into the TUI's component tree.
 *
 * Usage:
 * ```ts
 * const runner = new JobRunner(definition, executor);
 * const tui = new TuiApp(runner, definition);
 * tui.start();
 * const result = await runner.run();
 * tui.stop();
 * ```
 */

import { TUI, ProcessTerminal, type Terminal } from "@mariozechner/pi-tui";
import type { JobRunner } from "../job-runner.js";
import type { JobDefinition, StageId, TaskId, TaskDefinition } from "../types.js";
import type { JobState } from "../state.js";
import { projectState } from "../state.js";
import { DashboardView } from "./views/dashboard.js";
import { StageView } from "./views/stage.js";
import { TaskView } from "./views/task.js";
import { HelpView } from "./views/help.js";
import { EventLogView } from "./views/event-log.js";

type ActiveView =
	| { type: "dashboard"; view: DashboardView }
	| { type: "stage"; view: StageView; stageId: StageId }
	| { type: "task"; view: TaskView; taskId: TaskId }
	| { type: "event_log"; view: EventLogView };

export type TuiAppOpts = {
	terminal?: Terminal;
};

export class TuiApp {
	private readonly tui: TUI;
	private readonly terminal: Terminal;
	private readonly definition: JobDefinition;
	private readonly runner: JobRunner;
	private state: JobState;
	private viewStack: ActiveView[];
	private helpOverlay: HelpView | undefined;
	private unsubscribe: (() => void) | undefined;
	private renderTimer: ReturnType<typeof setInterval> | undefined;
	private readonly startTime: number;
	private started = false;

	constructor(runner: JobRunner, definition: JobDefinition, opts?: TuiAppOpts) {
		this.runner = runner;
		this.definition = definition;
		this.terminal = opts?.terminal ?? new ProcessTerminal();
		this.tui = new TUI(this.terminal);
		this.startTime = Date.now();

		this.state = {
			jobId: runner.jobId,
			status: "pending",
			stages: new Map(),
			tasks: new Map(),
			stageResults: new Map(),
			transitions: [],
			tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		};

		const dashboard = new DashboardView(definition);
		dashboard.setStartTime(this.startTime);
		dashboard.setState(this.state);
		dashboard.onAction = (a) => this.handleDashboardAction(a);
		this.viewStack = [{ type: "dashboard", view: dashboard }];
	}

	start(): void {
		if (this.started) return;
		this.started = true;

		this.syncActiveView();
		this.tui.start();

		const log = this.runner.getEventLog();
		this.unsubscribe = log.subscribe(() => {
			this.state = projectState(log.getEvents());
			this.updateViewStates();
			this.tui.requestRender();
		});

		this.renderTimer = setInterval(() => {
			this.tui.requestRender();
		}, 1000);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;

		if (this.renderTimer) {
			clearInterval(this.renderTimer);
			this.renderTimer = undefined;
		}
		this.unsubscribe?.();
		this.unsubscribe = undefined;

		this.tui.stop();
	}

	private get activeView(): ActiveView {
		return this.viewStack[this.viewStack.length - 1];
	}

	private syncActiveView(): void {
		this.tui.clear();
		const av = this.activeView;
		if (this.helpOverlay) {
			this.tui.addChild(this.helpOverlay);
			this.tui.setFocus(this.helpOverlay);
		} else {
			this.tui.addChild(av.view);
			this.tui.setFocus(av.view);
		}
	}

	private updateViewStates(): void {
		for (const entry of this.viewStack) {
			switch (entry.type) {
				case "dashboard": entry.view.setState(this.state); break;
				case "stage": entry.view.setState(this.state); break;
				case "task": entry.view.setState(this.state); break;
				case "event_log": entry.view.setEvents(this.runner.getEventLog().getEvents()); break;
			}
		}
	}

	private handleDashboardAction(action: import("./views/dashboard.js").DashboardAction): void {
		switch (action.type) {
			case "drill_stage": {
				const stageDef = this.definition.stages.find((s) => s.id === action.stageId);
				const name = stageDef?.name ?? action.stageId;
				const breadcrumb = `Job → ${name}`;
				const view = new StageView(action.stageId, stageDef, breadcrumb);
				view.setState(this.state);
				view.onAction = (a) => this.handleStageAction(a, name);
				this.viewStack.push({ type: "stage", view, stageId: action.stageId });
				this.syncActiveView();
				break;
			}
			case "pause":
				this.runner.pause("Paused by user");
				break;
			case "resume":
				this.runner.resume();
				break;
			case "cancel":
				this.runner.cancel();
				break;
			case "toggle_log":
				this.showEventLog();
				break;
			case "help":
				this.showHelp();
				break;
			case "quit":
				this.stop();
				break;
		}
	}

	private handleStageAction(action: import("./views/stage.js").StageViewAction, stageName: string): void {
		switch (action.type) {
			case "back":
				if (this.viewStack.length > 1) {
					this.viewStack.pop();
					this.syncActiveView();
				}
				break;
			case "drill_task": {
				const taskDef = this.findTaskDef(action.taskId);
				const breadcrumb = `Job → ${stageName} → ${action.taskId}`;
				const view = new TaskView(action.taskId, taskDef, breadcrumb);
				view.setState(this.state);
				view.onAction = (a) => this.handleTaskAction(a);
				this.viewStack.push({ type: "task", view, taskId: action.taskId });
				this.syncActiveView();
				break;
			}
			case "help":
				this.showHelp();
				break;
			case "quit":
				this.stop();
				break;
		}
	}

	private handleTaskAction(action: import("./views/task.js").TaskViewAction): void {
		switch (action.type) {
			case "back":
				if (this.viewStack.length > 1) {
					this.viewStack.pop();
					this.syncActiveView();
				}
				break;
			case "cancel_task":
				this.runner.cancelTask(action.taskId, action.stageId);
				break;
			case "help":
				this.showHelp();
				break;
			case "quit":
				this.stop();
				break;
		}
	}

	private showHelp(): void {
		this.helpOverlay = new HelpView();
		this.helpOverlay.onAction = (a) => {
			if (a.type === "close") {
				this.helpOverlay = undefined;
				this.syncActiveView();
				this.tui.requestRender();
			}
		};
		this.syncActiveView();
		this.tui.requestRender();
	}

	private showEventLog(): void {
		const view = new EventLogView();
		view.setEvents(this.runner.getEventLog().getEvents());
		view.onAction = (a) => {
			switch (a.type) {
				case "back":
					if (this.viewStack.length > 1) {
						this.viewStack.pop();
						this.syncActiveView();
					}
					break;
				case "help": this.showHelp(); break;
				case "quit": this.stop(); break;
			}
		};
		this.viewStack.push({ type: "event_log", view });
		this.syncActiveView();
		this.tui.requestRender();
	}

	private findTaskDef(taskId: TaskId): TaskDefinition | undefined {
		for (const stage of this.definition.stages) {
			const td = stage.tasks.find((t) => t.id === taskId);
			if (td) return td;
		}
		return undefined;
	}
}
