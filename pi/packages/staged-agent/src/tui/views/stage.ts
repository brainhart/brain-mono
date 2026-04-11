import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import type { JobState, TaskState } from "../../state.js";
import type { StageDefinition, StageId, TaskId } from "../../types.js";
import {
	colored, statusIcon, statusLabel, formatDuration, horizontalRule, padRight,
	FG_CYAN, FG_GRAY, FG_YELLOW, FG_RED, FG_WHITE, BOLD, DIM,
} from "../helpers.js";
import { parseNavKey, KeyState, clampCursor, renderFooter } from "../keybindings.js";

export type StageViewAction =
	| { type: "back" }
	| { type: "drill_task"; taskId: TaskId }
	| { type: "help" }
	| { type: "quit" };

export class StageView implements Component {
	private cursor = 0;
	private taskIds: TaskId[];
	private readonly keyState = new KeyState();
	private state: JobState | undefined;
	private breadcrumb: string;
	onAction: ((action: StageViewAction) => void) | undefined;

	constructor(
		readonly stageId: StageId,
		private readonly stageDef: StageDefinition | undefined,
		breadcrumb?: string,
	) {
		this.taskIds = stageDef?.tasks.map((t) => t.id) ?? [];
		this.breadcrumb = breadcrumb ?? `Job → ${stageDef?.name ?? stageId}`;
	}

	setState(state: JobState): void { this.state = state; }
	invalidate(): void {}

	handleInput(data: string): void {
		const nav = parseNavKey(data, this.keyState);
		if (!nav) return;
		switch (nav.type) {
			case "up":    this.cursor = clampCursor(this.cursor - 1, this.taskIds.length); return;
			case "down":  this.cursor = clampCursor(this.cursor + 1, this.taskIds.length); return;
			case "top":   this.cursor = 0; return;
			case "bottom": this.cursor = clampCursor(this.taskIds.length - 1, this.taskIds.length); return;
			case "half_page_up":   this.cursor = clampCursor(this.cursor - 5, this.taskIds.length); return;
			case "half_page_down": this.cursor = clampCursor(this.cursor + 5, this.taskIds.length); return;
			case "enter": if (this.taskIds.length > 0) this.onAction?.({ type: "drill_task", taskId: this.taskIds[this.cursor] }); return;
			case "back":  this.onAction?.({ type: "back" }); return;
			case "help":  this.onAction?.({ type: "help" }); return;
			case "quit":  this.onAction?.({ type: "quit" }); return;
		}
	}

	render(width: number): string[] {
		const state = this.state;
		if (!state) return ["(no state)"];
		const lines: string[] = [];
		const ss = state.stages.get(this.stageId);
		const status = ss?.status ?? "waiting";
		const attempt = ss?.attemptCount ?? 0;
		const name = this.stageDef?.name ?? this.stageId;
		const policy = this.stageDef?.completionPolicy?.type ?? "all";
		const now = Date.now();

		lines.push(colored(` ${this.breadcrumb}`, FG_GRAY, DIM));
		lines.push(horizontalRule(width));
		lines.push(
			colored(` Stage: ${name} `, BOLD, FG_WHITE)
			+ "  " + statusLabel(status)
			+ (attempt > 0 ? colored(`  attempt ${attempt}`, FG_YELLOW) : "")
			+ (ss?.startedAt ? "  " + colored(formatDuration((ss.completedAt ?? now) - ss.startedAt), FG_GRAY) : ""),
		);
		lines.push(
			colored(`  policy: ${policy}`, FG_GRAY)
			+ (this.stageDef?.maxTaskAttempts
				? colored(`  max-retries: ${this.stageDef.maxTaskAttempts}`, FG_GRAY)
				: ""),
		);
		if (ss?.error) {
			lines.push(colored(`  error: ${ss.error}`, FG_RED));
		}
		lines.push(horizontalRule(width));
		lines.push("");

		const rowWidth = Math.max(1, width - 3);
		for (let i = 0; i < this.taskIds.length; i++) {
			const tid = this.taskIds[i];
			const ts = state.tasks.get(tid);
			const line = this.renderTaskLine(tid, ts, rowWidth, now);
			const prefix = i === this.cursor
				? colored(" ▶ ", FG_CYAN, BOLD)
				: "   ";
			lines.push(prefix + line);
		}

		lines.push("");
		lines.push(horizontalRule(width));
		lines.push(renderFooter([["j/k", "nav"], ["⏎/l", "select"], ["h/esc", "back"], ["?", "help"], ["q", "quit"]], { mode: "NORMAL" }));
		return lines;
	}

	private renderTaskLine(taskId: TaskId, ts: TaskState | undefined, cols: number, now: number): string {
		const status = ts?.status ?? "pending";
		const icon = statusIcon(status);
		const attempt = ts?.attemptCount ?? 0;

		let info = "";
		if (ts?.result) {
			const summaryText = truncateToWidth(ts.result.summary, Math.floor(cols * 0.35));
			info = colored(` ${summaryText}`, FG_GRAY);
		} else if (ts?.error) {
			const errText = truncateToWidth(ts.error, Math.floor(cols * 0.35));
			info = colored(` ${errText}`, FG_RED);
		}

		let timeStr = "";
		if (ts?.startedAt) {
			const end = ts.completedAt ?? now;
			timeStr = colored(` ${formatDuration(end - ts.startedAt)}`, FG_GRAY, DIM);
		}

		let retryStr = "";
		if (attempt > 1) retryStr = colored(` retry ${attempt}`, FG_YELLOW);

		const maxName = Math.min(25, Math.floor(cols * 0.25));
		const nameStr = padRight(truncateToWidth(taskId, maxName), maxName);
		return `[${icon}] ${nameStr}${info}${timeStr}${retryStr}`;
	}
}
