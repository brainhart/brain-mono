/**
 * Main TUI application for observing and controlling a staged-agent job.
 *
 * Uses pi-tui's `TUI` and `ProcessTerminal` for rendering, input, and
 * terminal management. The staged-agent views are pi-tui `Component`
 * implementations that render into the TUI's component tree.
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
import { DagView } from "./views/dag.js";
import { TranscriptView, parseTranscript } from "./views/transcript.js";

type ActiveView =
	| { type: "dashboard"; view: DashboardView }
	| { type: "stage"; view: StageView; stageId: StageId }
	| { type: "task"; view: TaskView; taskId: TaskId }
	| { type: "event_log"; view: EventLogView }
	| { type: "dag"; view: DagView }
	| { type: "transcript"; view: TranscriptView };

export type TuiAppOpts = {
	terminal?: Terminal;
	/** Working directory for resolving session files. */
	cwd?: string;
};

export class TuiApp {
	private readonly tui: TUI;
	private readonly terminal: Terminal;
	private readonly definition: JobDefinition;
	private readonly runner: JobRunner;
	private readonly cwd: string;
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
		this.cwd = opts?.cwd ?? process.cwd();
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
				case "dag": entry.view.setState(this.state); break;
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
				this.pushView({ type: "event_log", view: this.createEventLogView() });
				break;
			case "view_dag":
				this.pushView({ type: "dag", view: this.createDagView() });
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
				this.popView();
				break;
			case "drill_task": {
				const taskDef = this.findTaskDef(action.taskId);
				const breadcrumb = `Job → ${stageName} → ${action.taskId}`;
				const view = new TaskView(action.taskId, taskDef, breadcrumb);
				view.setState(this.state);
				view.onAction = (a) => this.handleTaskAction(a);
				this.pushView({ type: "task", view, taskId: action.taskId });
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
				this.popView();
				break;
			case "cancel_task":
				this.runner.cancelTask(action.taskId, action.stageId);
				break;
			case "view_transcript":
				this.openTranscript(action.taskId, action.sessionFile, action.sessionId);
				break;
			case "help":
				this.showHelp();
				break;
			case "quit":
				this.stop();
				break;
		}
	}

	private pushView(entry: ActiveView): void {
		this.viewStack.push(entry);
		this.syncActiveView();
		this.tui.requestRender();
	}

	private popView(): void {
		if (this.viewStack.length > 1) {
			this.viewStack.pop();
			this.syncActiveView();
		}
	}

	private showHelp(): void {
		this.helpOverlay = new HelpView();
		this.helpOverlay.onAction = (a) => {
			if (a.type === "close") {
				this.helpOverlay = undefined;
				this.syncActiveView();
				this.tui.requestRender();
			} else if (a.type === "quit") {
				this.helpOverlay = undefined;
				this.stop();
			}
		};
		this.syncActiveView();
		this.tui.requestRender();
	}

	private createEventLogView(): EventLogView {
		const view = new EventLogView();
		view.setEvents(this.runner.getEventLog().getEvents());
		view.onAction = (a) => this.handleGenericViewAction(a);
		return view;
	}

	private createDagView(): DagView {
		const view = new DagView(this.definition);
		view.setState(this.state);
		view.onAction = (a) => this.handleGenericViewAction(a);
		return view;
	}

	private handleGenericViewAction(action: { type: string }): void {
		switch (action.type) {
			case "back": this.popView(); break;
			case "help": this.showHelp(); break;
			case "quit": this.stop(); break;
		}
	}

	private openTranscript(taskId: string, sessionFile?: string, sessionId?: string): void {
		const displayId = sessionId ?? sessionFile ?? "unknown";
		const view = new TranscriptView(taskId, displayId);
		view.onAction = (a) => this.handleGenericViewAction(a);
		this.pushView({ type: "transcript", view });

		if (sessionFile) {
			view.setLoading(true);
			this.tui.requestRender();

			this.loadTranscript(sessionFile).then(
				(entries) => {
					view.setEntries(entries);
					this.tui.requestRender();
				},
				(err) => {
					view.setError(err instanceof Error ? err.message : String(err));
					this.tui.requestRender();
				},
			);
		} else {
			view.setError("No session file available for this task");
		}
	}

	private async loadTranscript(sessionFile: string): Promise<import("./views/transcript.js").TranscriptEntry[]> {
		try {
			const { SessionManager } = await import("@mariozechner/pi-coding-agent");
			const sm = SessionManager.open(sessionFile);
			const entries = sm.getEntries();
			return parseTranscript(entries);
		} catch (err) {
			throw new Error(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private findTaskDef(taskId: TaskId): TaskDefinition | undefined {
		for (const stage of this.definition.stages) {
			const td = stage.tasks.find((t) => t.id === taskId);
			if (td) return td;
		}
		return undefined;
	}
}
