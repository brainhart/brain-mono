import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { JobState, StageState } from "../../state.js";
import type { JobDefinition, StageId, TaskStatus } from "../../types.js";
import {
	colored, statusIcon, statusLabel, formatDuration, horizontalRule, padRight,
	FG_CYAN, FG_GRAY, FG_YELLOW, FG_RED, FG_GREEN, FG_WHITE, BOLD, DIM,
} from "../helpers.js";

export type DashboardAction =
	| { type: "drill_stage"; stageId: StageId }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "cancel" }
	| { type: "help" }
	| { type: "toggle_log" }
	| { type: "quit" };

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
		} else if (matchesKey(data, "l")) {
			this.onAction?.({ type: "toggle_log" });
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
		const now = Date.now();
		const elapsed = formatDuration(now - this.startTime);

		lines.push(horizontalRule(width));
		lines.push(
			colored(` Job ${truncateToWidth(state.jobId, 20)}`, BOLD, FG_WHITE)
			+ "  " + statusLabel(state.status)
			+ "  " + colored(elapsed, FG_GRAY),
		);
		if (state.error) {
			lines.push(colored(`  ${state.error}`, FG_RED));
		}
		lines.push(horizontalRule(width));
		lines.push("");

		const dynStageIds = [...state.stages.keys()].filter((id) => !this.stageIds.includes(id));
		if (dynStageIds.length > 0) {
			this.stageIds = [...this.definition.stages.map((s) => s.id), ...dynStageIds];
		}

		for (let i = 0; i < this.stageIds.length; i++) {
			const sid = this.stageIds[i];
			const ss = state.stages.get(sid);
			const line = this.renderStageLine(sid, ss, width, state, now);
			const prefix = i === this.cursor
				? colored(" ▶ ", FG_CYAN, BOLD)
				: "   ";
			lines.push(prefix + line);
		}

		lines.push("");

		const summary = this.renderSummary(state, now);
		if (summary) {
			lines.push(summary);
			lines.push("");
		}

		lines.push(horizontalRule(width));
		lines.push(this.renderFooter(state.status));
		return lines;
	}

	private renderStageLine(
		stageId: StageId, ss: StageState | undefined,
		cols: number, state: JobState, now: number,
	): string {
		const status = ss?.status ?? "waiting";
		const icon = statusIcon(status);
		const stageDef = this.definition.stages.find((s) => s.id === stageId);
		const name = stageDef?.name ?? stageId;
		const taskIds = stageDef?.tasks.map((t) => t.id) ?? [];
		const attempt = ss?.attemptCount ?? 0;

		const taskCounts = this.countTasks(taskIds, state);
		const progressStr = taskCounts.total > 0
			? `${taskCounts.completed}/${taskCounts.total}`
			: "0";
		let taskInfo = colored(progressStr, taskCounts.completed === taskCounts.total && taskCounts.total > 0 ? FG_GREEN : FG_WHITE);
		if (taskCounts.running > 0) taskInfo += colored(` (${taskCounts.running} running)`, FG_CYAN);
		if (taskCounts.failed > 0) taskInfo += colored(` (${taskCounts.failed} failed)`, FG_RED);

		let timeStr = "";
		if (ss?.startedAt) {
			const end = ss.completedAt ?? now;
			timeStr = colored(`  ${formatDuration(end - ss.startedAt)}`, FG_GRAY);
		}

		let attemptStr = "";
		if (attempt > 1) attemptStr = colored(`  attempt ${attempt}`, FG_YELLOW);

		const maxName = Math.min(25, Math.floor(cols * 0.25));
		const nameStr = padRight(truncateToWidth(name, maxName), maxName);
		return `[${icon}] ${nameStr}  ${taskInfo}${timeStr}${attemptStr}`;
	}

	private countTasks(taskIds: string[], state: JobState): { total: number; completed: number; running: number; failed: number } {
		let completed = 0, running = 0, failed = 0;
		for (const tid of taskIds) {
			const ts = state.tasks.get(tid);
			if (!ts) continue;
			if (ts.status === "completed") completed++;
			else if (ts.status === "running") running++;
			else if (ts.status === "failed") failed++;
		}
		return { total: taskIds.length, completed, running, failed };
	}

	private renderSummary(state: JobState, now: number): string | undefined {
		const allTasks = [...state.tasks.values()];
		if (allTasks.length === 0) return undefined;

		const completed = allTasks.filter((t) => t.status === "completed").length;
		const running = allTasks.filter((t) => t.status === "running").length;
		const failed = allTasks.filter((t) => t.status === "failed").length;
		const total = allTasks.length;

		const parts: string[] = [];
		parts.push(colored(`  Tasks: ${completed}/${total} done`, FG_GRAY));
		if (running > 0) parts.push(colored(`${running} active`, FG_CYAN));
		if (failed > 0) parts.push(colored(`${failed} failed`, FG_RED));

		const { totalTokens } = state.tokenUsage;
		if (totalTokens > 0) {
			const tokStr = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : String(totalTokens);
			parts.push(colored(`${tokStr} tokens`, FG_GRAY, DIM));
		}

		if (state.pauseReason) {
			parts.push(colored(`paused: "${state.pauseReason}"`, FG_YELLOW));
		}

		return parts.join(colored(" · ", FG_GRAY, DIM));
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
		keys.push(colored("l", FG_GRAY) + " log");
		keys.push(colored("?", FG_GRAY) + " help");
		keys.push(colored("q", FG_GRAY) + " quit");
		return " " + keys.join("  ");
	}
}
