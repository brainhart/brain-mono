import type { JobState, TaskState } from "../../state.js";
import type { StageDefinition, StageId, TaskId } from "../../types.js";
import { colored, fg, style, screen as scr } from "../ansi.js";
import { formatDuration, horizontalRule, padRight, truncate } from "../format.js";
import { statusIcon, statusLabel } from "../symbols.js";
import type { KeyEvent } from "../screen.js";

export type StageViewAction =
	| { type: "back" }
	| { type: "drill_task"; taskId: TaskId }
	| { type: "help" }
	| { type: "quit" };

export class StageView {
	private cursor = 0;
	private taskIds: TaskId[];

	constructor(
		readonly stageId: StageId,
		private readonly stageDef: StageDefinition | undefined,
	) {
		this.taskIds = stageDef?.tasks.map((t) => t.id) ?? [];
	}

	handleInput(key: KeyEvent): StageViewAction | undefined {
		switch (key.type) {
			case "up":
				this.cursor = Math.max(0, this.cursor - 1);
				return undefined;
			case "down":
				this.cursor = Math.min(this.taskIds.length - 1, this.cursor + 1);
				return undefined;
			case "enter":
				if (this.taskIds.length > 0) {
					return { type: "drill_task", taskId: this.taskIds[this.cursor] };
				}
				return undefined;
			case "escape":
			case "backspace":
				return { type: "back" };
			case "char":
				switch (key.char) {
					case "k": this.cursor = Math.max(0, this.cursor - 1); return undefined;
					case "j": this.cursor = Math.min(this.taskIds.length - 1, this.cursor + 1); return undefined;
					case "?": return { type: "help" };
					case "q": return { type: "quit" };
				}
				return undefined;
			default:
				return undefined;
		}
	}

	render(state: JobState, cols: number, rows: number): string {
		const lines: string[] = [];
		const ss = state.stages.get(this.stageId);
		const status = ss?.status ?? "waiting";
		const attempt = ss?.attemptCount ?? 0;
		const name = this.stageDef?.name ?? this.stageId;
		const policy = this.stageDef?.completionPolicy?.type ?? "all";

		lines.push(horizontalRule(cols, "─"));
		lines.push(
			colored(` Stage: ${name} `, style.bold, fg.brightWhite)
			+ "  " + statusLabel(status)
			+ (attempt > 0 ? colored(`  attempt ${attempt}`, fg.yellow) : "")
		);
		lines.push(
			colored(`  policy: ${policy}`, fg.gray)
			+ (this.stageDef?.maxTaskAttempts
				? colored(`  max-retries: ${this.stageDef.maxTaskAttempts}`, fg.gray)
				: "")
		);
		lines.push(horizontalRule(cols, "─"));
		lines.push("");

		for (let i = 0; i < this.taskIds.length; i++) {
			const tid = this.taskIds[i];
			const ts = state.tasks.get(tid);
			const line = this.renderTaskLine(tid, ts, cols);
			const prefix = i === this.cursor
				? colored(" ▶ ", fg.cyan, style.bold)
				: "   ";
			lines.push(prefix + line);
		}

		lines.push("");
		lines.push(horizontalRule(cols, "─"));
		lines.push(this.renderFooter());

		const maxLines = rows - 1;
		while (lines.length < maxLines) lines.push("");
		if (lines.length > maxLines) lines.length = maxLines;

		return lines.map((l) => scr.clearLine + l).join("\n");
	}

	private renderTaskLine(
		taskId: TaskId,
		ts: TaskState | undefined,
		cols: number,
	): string {
		const status = ts?.status ?? "pending";
		const icon = statusIcon(status);
		const attempt = ts?.attemptCount ?? 0;

		let info = "";
		if (ts?.result) {
			const summaryText = truncate(ts.result.summary, Math.floor(cols * 0.4));
			info = colored(` ${summaryText}`, fg.gray);
		}
		if (attempt > 1) {
			info += colored(`  retry ${attempt}`, fg.yellow);
		}

		const maxName = Math.min(30, Math.floor(cols * 0.3));
		const nameStr = padRight(truncate(taskId, maxName), maxName);
		return `[${icon}] ${nameStr}${info}`;
	}

	private renderFooter(): string {
		const keys: string[] = [];
		keys.push(colored("↑↓", fg.cyan) + " navigate");
		keys.push(colored("enter", fg.cyan) + " drill-down");
		keys.push(colored("esc", fg.gray) + " back");
		keys.push(colored("?", fg.gray) + " help");
		keys.push(colored("q", fg.gray) + " quit");
		return " " + keys.join("  ");
	}
}
