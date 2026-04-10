import type { JobRunner } from "../job-runner.js";
import type { JobDefinition, StageId, TaskId, TaskDefinition } from "../types.js";
import type { JobState } from "../state.js";
import { projectState } from "../state.js";
import { Screen, type KeyEvent } from "./screen.js";
import { cursor } from "./ansi.js";
import { DashboardView, type DashboardAction } from "./views/dashboard.js";
import { StageView, type StageViewAction } from "./views/stage.js";
import { TaskView, type TaskViewAction } from "./views/task.js";
import { HelpView } from "./views/help.js";

type ActiveView =
	| { type: "dashboard"; view: DashboardView }
	| { type: "stage"; view: StageView; stageId: StageId }
	| { type: "task"; view: TaskView; taskId: TaskId };

export type TuiAppOpts = {
	stdout?: NodeJS.WriteStream;
	stdin?: NodeJS.ReadStream;
};

/**
 * Interactive TUI for observing and controlling a staged-agent job.
 *
 * Subscribes to the job's event log for real-time updates and renders
 * a navigable hierarchy: job dashboard → stage detail → task detail.
 * Supports pause/resume/cancel from the keyboard.
 *
 * Usage:
 * ```ts
 * const runner = new JobRunner(definition, executor);
 * const tui = new TuiApp(runner, definition);
 * tui.start();                    // enters TUI mode
 * const result = await runner.run(); // job runs while TUI is active
 * tui.stop();                     // exits TUI mode
 * ```
 */
export class TuiApp {
	private readonly screen: Screen;
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
		this.screen = new Screen(opts?.stdout, opts?.stdin);
		this.startTime = Date.now();

		this.state = {
			jobId: runner.jobId,
			status: "pending",
			stages: new Map(),
			tasks: new Map(),
			stageResults: new Map(),
		};

		const dashboard = new DashboardView(definition);
		this.viewStack = [{ type: "dashboard", view: dashboard }];
	}

	start(): void {
		if (this.started) return;
		this.started = true;

		this.screen.start((key) => this.onInput(key));

		const log = this.runner.getEventLog();
		this.unsubscribe = log.subscribe(() => {
			this.state = projectState(log.getEvents());
			this.render();
		});

		this.renderTimer = setInterval(() => this.render(), 1000);

		this.render();
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

		this.screen.stop();
	}

	private get activeView(): ActiveView {
		return this.viewStack[this.viewStack.length - 1];
	}

	private onInput(key: KeyEvent): void {
		if (key.type === "resize") {
			this.render();
			return;
		}

		if (this.helpOverlay) {
			const action = this.helpOverlay.handleInput(key);
			if (action?.type === "close") {
				this.helpOverlay = undefined;
				this.render();
			}
			return;
		}

		const av = this.activeView;
		switch (av.type) {
			case "dashboard":
				this.handleDashboardAction(av.view.handleInput(key));
				break;
			case "stage":
				this.handleStageAction(av.view.handleInput(key));
				break;
			case "task":
				this.handleTaskAction(av.view.handleInput(key));
				break;
		}

		this.render();
	}

	private handleDashboardAction(action: DashboardAction | undefined): void {
		if (!action) return;
		switch (action.type) {
			case "drill_stage": {
				const stageDef = this.definition.stages.find((s) => s.id === action.stageId);
				const view = new StageView(action.stageId, stageDef);
				this.viewStack.push({ type: "stage", view, stageId: action.stageId });
				break;
			}
			case "pause":
				this.runner.cancel();
				break;
			case "resume":
				this.runner.resume();
				break;
			case "cancel":
				this.runner.cancel();
				break;
			case "help":
				this.helpOverlay = new HelpView();
				break;
			case "quit":
				this.stop();
				break;
		}
	}

	private handleStageAction(action: StageViewAction | undefined): void {
		if (!action) return;
		switch (action.type) {
			case "back":
				if (this.viewStack.length > 1) this.viewStack.pop();
				break;
			case "drill_task": {
				const taskDef = this.findTaskDef(action.taskId);
				const view = new TaskView(action.taskId, taskDef);
				this.viewStack.push({ type: "task", view, taskId: action.taskId });
				break;
			}
			case "help":
				this.helpOverlay = new HelpView();
				break;
			case "quit":
				this.stop();
				break;
		}
	}

	private handleTaskAction(action: TaskViewAction | undefined): void {
		if (!action) return;
		switch (action.type) {
			case "back":
				if (this.viewStack.length > 1) this.viewStack.pop();
				break;
			case "help":
				this.helpOverlay = new HelpView();
				break;
			case "quit":
				this.stop();
				break;
		}
	}

	private findTaskDef(taskId: TaskId): TaskDefinition | undefined {
		for (const stage of this.definition.stages) {
			const td = stage.tasks.find((t) => t.id === taskId);
			if (td) return td;
		}
		return undefined;
	}

	private render(): void {
		if (!this.started) return;

		const cols = this.screen.cols;
		const rows = this.screen.rows;
		let content: string;

		if (this.helpOverlay) {
			content = this.helpOverlay.render(cols, rows);
		} else {
			const av = this.activeView;
			switch (av.type) {
				case "dashboard":
					content = av.view.render(this.state, cols, rows, this.startTime);
					break;
				case "stage":
					content = av.view.render(this.state, cols, rows);
					break;
				case "task":
					content = av.view.render(this.state, cols, rows);
					break;
			}
		}

		this.screen.write(cursor.home + content);
	}
}
