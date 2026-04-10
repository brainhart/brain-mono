import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { JobState, StageState } from "../../state.js";
import type { JobDefinition, StageId } from "../../types.js";
import {
	colored, statusIcon, statusLabel, formatDuration, horizontalRule, padRight,
	FG_CYAN, FG_GRAY, FG_YELLOW, FG_RED, FG_GREEN, FG_WHITE, BOLD,
} from "../helpers.js";

export type DashboardAction =
	| { type: "drill_stage"; stageId: StageId }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "cancel" }
	| { type: "help" }
	| { type: "quit" };

/**
 * Job-level dashboard component.
 * Lists all stages with status, task counts, and elapsed time.
 * Implements pi-tui Component interface for rendering and input.
 */
export class DashboardView implements Component {
	private cursor = 0;
	private stageIds: StageId[];
	private state: JobState | undefined;
	private startTime = Date.now();
	onAction: ((action: DashboardAction) => void) | undefined;

	constructor(private readonly definition: JobDefinition) {
		this.stageIds = definition.stages.map((s) => s.id);
	}

	setStartTime(t: number): void { this.startTime = t; }

	setState(state: JobState): void { this.state = state; }

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.cursor = Math.max(0, this.cursor - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.cursor = Math.min(this.stageIds.length - 1, this.cursor + 1);
		} else if (matchesKey(data, "enter")) {
			if (this.stageIds.length > 0) {
				this.onAction?.({ type: "drill_stage", stageId: this.stageIds[this.cursor] });
			}
		} else if (matchesKey(data, "p")) {
			this.onAction?.({ type: "pause" });
		} else if (matchesKey(data, "r")) {
			this.onAction?.({ type: "resume" });
		} else if (matchesKey(data, "c")) {
			this.onAction?.({ type: "cancel" });
		} else if (matchesKey(data, "?")) {
			this.onAction?.({ type: "help" });
		} else if (matchesKey(data, "q")) {
			this.onAction?.({ type: "quit" });
		}
	}

	render(width: number): string[] {
		const state = this.state;
		if (!state) return ["(no state)"];

		const lines: string[] = [];
		const elapsed = formatDuration(Date.now() - this.startTime);

		lines.push(horizontalRule(width));
		lines.push(
			colored(` Job ${truncateToWidth(state.jobId, 20)}`, BOLD, FG_WHITE)
			+ "  " + statusLabel(state.status)
			+ "  " + colored(elapsed, FG_GRAY),
		);
		lines.push(horizontalRule(width));
		lines.push("");

		const dynStageIds = [...state.stages.keys()].filter((id) => !this.stageIds.includes(id));
		if (dynStageIds.length > 0) {
			this.stageIds = [...this.definition.stages.map((s) => s.id), ...dynStageIds];
		}

		for (let i = 0; i < this.stageIds.length; i++) {
			const sid = this.stageIds[i];
			const ss = state.stages.get(sid);
			const line = this.renderStageLine(sid, ss, width);
			const prefix = i === this.cursor
				? colored(" ▶ ", FG_CYAN, BOLD)
				: "   ";
			lines.push(prefix + line);
		}

		lines.push("");
		lines.push(horizontalRule(width));
		lines.push(this.renderFooter(state.status));
		return lines;
	}

	private renderStageLine(stageId: StageId, ss: StageState | undefined, cols: number): string {
		const status = ss?.status ?? "waiting";
		const icon = statusIcon(status);
		const stageDef = this.definition.stages.find((s) => s.id === stageId);
		const name = stageDef?.name ?? stageId;
		const taskCount = stageDef?.tasks.length ?? 0;
		const attempt = ss?.attemptCount ?? 0;

		let info = `${taskCount} tasks`;
		if (attempt > 1) info += colored(`  attempt ${attempt}`, FG_YELLOW);

		const maxName = Math.min(30, Math.floor(cols * 0.3));
		const nameStr = padRight(truncateToWidth(name, maxName), maxName);
		return `[${icon}] ${nameStr}  ${info}`;
	}

	private renderFooter(jobStatus: string): string {
		const keys: string[] = [];
		keys.push(colored("↑↓", FG_CYAN) + " navigate");
		keys.push(colored("enter", FG_CYAN) + " drill-down");
		if (jobStatus === "running") {
			keys.push(colored("p", FG_YELLOW) + " pause");
			keys.push(colored("c", FG_RED) + " cancel");
		}
		if (jobStatus === "paused") {
			keys.push(colored("r", FG_GREEN) + " resume");
			keys.push(colored("c", FG_RED) + " cancel");
		}
		keys.push(colored("?", FG_GRAY) + " help");
		keys.push(colored("q", FG_GRAY) + " quit");
		return " " + keys.join("  ");
	}
}
