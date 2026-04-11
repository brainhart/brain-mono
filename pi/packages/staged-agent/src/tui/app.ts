/**
 * Main TUI application for observing and controlling a staged-agent job.
 *
 * Uses pi-tui's `TUI` and `ProcessTerminal` for rendering, input, and
 * terminal management. The staged-agent views are pi-tui `Component`
 * implementations that render into the TUI's component tree.
 */

import { TUI, ProcessTerminal, type Terminal } from "@mariozechner/pi-tui";
import { isAbsolute, resolve } from "node:path";
import type { JobRunner } from "../job-runner.js";
import type { JobDefinition, StageId, TaskId, TaskDefinition } from "../types.js";
import type { JobProfile } from "../profiles.js";
import { builtinProfiles } from "../profiles.js";
import type { JobState } from "../state.js";
import { projectState } from "../state.js";
import { DashboardView } from "./views/dashboard.js";
import { StageView } from "./views/stage.js";
import { TaskView } from "./views/task.js";
import { HelpView } from "./views/help.js";
import { EventLogView } from "./views/event-log.js";
import { DagView } from "./views/dag.js";
import { TranscriptView, parseTranscript } from "./views/transcript.js";
import { TaskActionMenuView } from "./views/task-actions.js";
import { TextPromptView } from "./views/text-prompt.js";
import { ProfilePickerView } from "./views/profile-picker.js";

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
	/** Invoked when the user requests to quit the TUI. */
	onQuit?: () => void;
	/** When true, enables interactive prompt submission via the TUI. */
	interactive?: boolean;
	/**
	 * Profiles available in the TUI profile picker. Defaults to the
	 * built-in profiles (single, plan-execute, plan-implement-review).
	 * Pass an empty array to skip the picker and always use the runner's
	 * default profile.
	 */
	profiles?: JobProfile[];
};

export class TuiApp {
	private readonly tui: TUI;
	private readonly terminal: Terminal;
	private readonly definition: JobDefinition;
	private readonly runner: JobRunner;
	private readonly cwd: string;
	private readonly onQuit: (() => void) | undefined;
	private readonly interactive: boolean;
	private readonly profiles: JobProfile[];
	private readonly profilesExplicit: boolean;
	private readonly dynamicStageDefs = new Map<string, import("../types.js").StageDefinition>();
	private nextStageNum = 1;
	private state: JobState;
	private viewStack: ActiveView[];
	private helpOverlay: HelpView | undefined;
	private taskActionOverlay: TaskActionMenuView | undefined;
	private textPromptOverlay: TextPromptView | undefined;
	private profilePickerOverlay: ProfilePickerView | undefined;
	private unsubscribe: (() => void) | undefined;
	private renderTimer: ReturnType<typeof setInterval> | undefined;
	private readonly startTime: number;
	private started = false;
	private transcriptLoadSeq = 0;
	private readonly taskTranscriptLoads = new Map<string, { loadSeq: number; sessionFile: string; view: TaskView }>();

	constructor(runner: JobRunner, definition: JobDefinition, opts?: TuiAppOpts) {
		this.runner = runner;
		this.definition = definition;
		this.terminal = opts?.terminal ?? new ProcessTerminal();
		this.tui = new TUI(this.terminal);
		this.cwd = opts?.cwd ?? process.cwd();
		this.onQuit = opts?.onQuit;
		this.interactive = opts?.interactive ?? false;
		this.profilesExplicit = opts?.profiles !== undefined;
		this.profiles = opts?.profiles ?? [];
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
		dashboard.setInteractive(this.interactive);
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
		} else if (this.textPromptOverlay) {
			this.tui.addChild(this.textPromptOverlay);
			this.tui.setFocus(this.textPromptOverlay);
		} else if (this.profilePickerOverlay) {
			this.tui.addChild(this.profilePickerOverlay);
			this.tui.setFocus(this.profilePickerOverlay);
		} else if (this.taskActionOverlay) {
			this.tui.addChild(this.taskActionOverlay);
			this.tui.setFocus(this.taskActionOverlay);
		} else {
			this.tui.addChild(av.view);
			this.tui.setFocus(av.view);
		}
	}

	private updateViewStates(): void {
		for (const entry of this.viewStack) {
			switch (entry.type) {
				case "dashboard":
					entry.view.addStageDefs(this.dynamicStageDefs);
					entry.view.setState(this.state);
					break;
				case "stage": entry.view.setState(this.state); break;
				case "task":
					entry.view.setState(this.state);
					this.maybeLoadInlineTranscript(entry.view, entry.taskId);
					break;
				case "event_log": entry.view.setEvents(this.runner.getEventLog().getEvents()); break;
				case "dag": entry.view.setState(this.state); break;
			}
		}
	}

	private handleDashboardAction(action: import("./views/dashboard.js").DashboardAction): void {
		switch (action.type) {
			case "drill_stage": {
				const stageDef = this.findStageDef(action.stageId);
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
			case "submit_prompt":
				this.openSubmitPrompt();
				break;
			case "finish":
				this.runner.finish();
				break;
			case "help":
				this.showHelp();
				break;
			case "quit":
				this.requestQuit();
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
				this.maybeLoadInlineTranscript(view, action.taskId);
				view.onAction = (a) => this.handleTaskAction(a);
				this.pushView({ type: "task", view, taskId: action.taskId });
				break;
			}
			case "help":
				this.showHelp();
				break;
			case "quit":
				this.requestQuit();
				break;
		}
	}

	private handleTaskAction(action: import("./views/task.js").TaskViewAction): void {
		switch (action.type) {
			case "back":
				this.popView();
				break;
			case "open_actions":
				this.openTaskActions(action.taskId);
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
				this.requestQuit();
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
			this.tui.requestRender();
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
				this.requestQuit();
			}
		};
		this.syncActiveView();
		this.tui.requestRender();
	}

	private openTaskActions(taskId: TaskId): void {
		const ts = this.state.tasks.get(taskId);
		if (!ts) return;
		const overlay = new TaskActionMenuView(taskId, {
			canCancel: ts.status === "running" && !!ts.stageId,
			canTranscript: typeof ts.result?.signals?.sessionFile === "string",
			canPauseWithNote: !!ts.stageId,
			canRetryWithNote: !!ts.stageId && ts.status !== "completed",
		});
		overlay.onAction = (a) => {
			if (a.type === "close") {
				this.taskActionOverlay = undefined;
				this.syncActiveView();
				this.tui.requestRender();
				return;
			}
			if (a.type === "quit") {
				this.taskActionOverlay = undefined;
				this.requestQuit();
				return;
			}

			const current = this.state.tasks.get(taskId);
			if (!current?.stageId) {
				this.taskActionOverlay = undefined;
				this.syncActiveView();
				this.tui.requestRender();
				return;
			}

			switch (a.type) {
				case "transcript":
					this.taskActionOverlay = undefined;
					this.openTranscript(
						taskId,
						current.result?.signals?.sessionFile as string | undefined,
						current.result?.signals?.sessionId as string | undefined ?? current.sessionId,
					);
					return;
				case "cancel_task":
					this.taskActionOverlay = undefined;
					this.runner.cancelTask(taskId, current.stageId);
					this.syncActiveView();
					this.tui.requestRender();
					return;
				case "note":
					this.openTaskNotePrompt(taskId, current.stageId, "note");
					return;
				case "retry_with_note":
					this.openTaskNotePrompt(taskId, current.stageId, "retry");
					return;
				case "pause_with_note":
					this.openTaskNotePrompt(taskId, current.stageId, "pause");
					return;
				default:
					return;
			}
		};
		this.taskActionOverlay = overlay;
		this.syncActiveView();
		this.tui.requestRender();
	}

	private openTaskNotePrompt(
		taskId: TaskId,
		stageId: StageId,
		mode: "note" | "retry" | "pause",
	): void {
		const title = mode === "retry"
			? "Interrupt and retry with note"
			: mode === "pause"
				? "Pause job after note"
				: "Add operator note";
		const prompt = mode === "retry"
			? "Add guidance for the next task attempt."
			: mode === "pause"
				? "Capture context before pausing the job."
				: "Record a note for this task.";
		const overlay = new TextPromptView(title, prompt, "Type a short note");
		overlay.onAction = (a) => {
			if (a.type === "cancel") {
				this.textPromptOverlay = undefined;
				this.syncActiveView();
				this.tui.requestRender();
				return;
			}
			this.textPromptOverlay = undefined;
			this.taskActionOverlay = undefined;
			if (mode === "retry") {
				this.runner.retryTaskWithNote(taskId, stageId, a.value);
			} else {
				this.runner.addTaskOperatorNote(taskId, stageId, a.value, mode);
				if (mode === "pause") {
					this.runner.pause(`Paused from task ${taskId}: ${a.value}`);
				}
			}
			this.syncActiveView();
			this.tui.requestRender();
		};
		this.textPromptOverlay = overlay;
		this.syncActiveView();
		this.tui.requestRender();
	}

	private openSubmitPrompt(): void {
		const profiles = this.availableProfiles;
		if (profiles.length <= 1) {
			this.openSubmitTextPrompt(profiles[0] ?? this.runner.getDefaultProfile());
			return;
		}

		const picker = new ProfilePickerView(profiles);
		picker.onAction = (a) => {
			if (a.type === "cancel") {
				this.profilePickerOverlay = undefined;
				this.syncActiveView();
				this.tui.requestRender();
				return;
			}
			if (a.type === "quit") {
				this.profilePickerOverlay = undefined;
				this.requestQuit();
				return;
			}
			this.profilePickerOverlay = undefined;
			this.openSubmitTextPrompt(a.profile);
		};
		this.profilePickerOverlay = picker;
		this.syncActiveView();
		this.tui.requestRender();
	}

	private openSubmitTextPrompt(profile: JobProfile): void {
		const overlay = new TextPromptView(
			`New task · ${profile.name}`,
			"Describe what you want the agent to do.",
			"e.g. Refactor the auth module to use JWT",
		);
		overlay.onAction = (a) => {
			if (a.type === "cancel") {
				this.textPromptOverlay = undefined;
				this.syncActiveView();
				this.tui.requestRender();
				return;
			}
			this.textPromptOverlay = undefined;
			const counter = this.runner.peekNextStageCounter();
			const { stages } = profile.generate(a.value, counter);
			for (const s of stages) {
				this.dynamicStageDefs.set(s.id, s);
			}
			this.runner.submitTask(a.value, profile);
			this.syncActiveView();
			this.tui.requestRender();
		};
		this.textPromptOverlay = overlay;
		this.syncActiveView();
		this.tui.requestRender();
	}

	private get availableProfiles(): JobProfile[] {
		if (this.profilesExplicit) return this.profiles;
		return this.profiles.length > 0 ? this.profiles : builtinProfiles;
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
			case "quit": this.requestQuit(); break;
		}
	}

	private requestQuit(): void {
		this.onQuit?.();
		this.stop();
	}

	private maybeLoadInlineTranscript(view: TaskView, taskId: TaskId): void {
		const taskState = this.state.tasks.get(taskId);
		const sessionFile = taskState?.result?.signals?.sessionFile;
		const sessionId = taskState?.result?.signals?.sessionId;
		const displayId = typeof sessionId === "string"
			? sessionId
			: typeof sessionFile === "string"
				? sessionFile
				: taskState?.sessionId ?? "unknown";
		if (typeof sessionFile !== "string" || sessionFile.length === 0) {
			view.clearTranscript();
			this.taskTranscriptLoads.delete(taskId);
			return;
		}

		const existingLoad = this.taskTranscriptLoads.get(taskId);
		if (existingLoad && existingLoad.sessionFile === sessionFile && existingLoad.view === view) {
			return;
		}

		const loadSeq = ++this.transcriptLoadSeq;
		this.taskTranscriptLoads.set(taskId, { loadSeq, sessionFile, view });
		view.setTranscriptLoading(displayId);
		this.loadTranscript(sessionFile).then(
			(entries) => {
				const activeLoad = this.taskTranscriptLoads.get(taskId);
				if (!this.started || !activeLoad || activeLoad.loadSeq !== loadSeq || activeLoad.view !== view) {
					return;
				}
				view.setTranscriptEntries(entries, displayId);
				this.tui.requestRender();
			},
			(err) => {
				const activeLoad = this.taskTranscriptLoads.get(taskId);
				if (!this.started || !activeLoad || activeLoad.loadSeq !== loadSeq || activeLoad.view !== view) {
					return;
				}
				view.setTranscriptError(err instanceof Error ? err.message : String(err), displayId);
				this.tui.requestRender();
			},
		);
	}

	private openTranscript(taskId: string, sessionFile?: string, sessionId?: string): void {
		const loadSeq = ++this.transcriptLoadSeq;
		const displayId = sessionId ?? sessionFile ?? "unknown";
		const view = new TranscriptView(taskId, displayId);
		view.onAction = (a) => this.handleGenericViewAction(a);
		this.pushView({ type: "transcript", view });

		if (sessionFile) {
			view.setLoading(true);
			this.tui.requestRender();

			this.loadTranscript(sessionFile).then(
				(entries) => {
					if (!this.started || this.transcriptLoadSeq !== loadSeq || this.activeView.view !== view) {
						return;
					}
					view.setEntries(entries);
					this.tui.requestRender();
				},
				(err) => {
					if (!this.started || this.transcriptLoadSeq !== loadSeq || this.activeView.view !== view) {
						return;
					}
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
			const resolvedPath = isAbsolute(sessionFile)
				? sessionFile
				: resolve(this.cwd, sessionFile);
			const sm = SessionManager.open(resolvedPath);
			const entries = sm.getEntries();
			return parseTranscript(entries, { cwd: sm.getCwd() });
		} catch (err) {
			throw new Error(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private findStageDef(stageId: StageId): import("../types.js").StageDefinition | undefined {
		const staticDef = this.definition.stages.find((s) => s.id === stageId);
		if (staticDef) return staticDef;
		return this.dynamicStageDefs.get(stageId);
	}

	private findTaskDef(taskId: TaskId): TaskDefinition | undefined {
		for (const stage of this.definition.stages) {
			const td = stage.tasks.find((t) => t.id === taskId);
			if (td) return td;
		}
		for (const [, stage] of this.dynamicStageDefs) {
			const td = stage.tasks.find((t) => t.id === taskId);
			if (td) return td;
		}
		return undefined;
	}
}
