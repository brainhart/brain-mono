import type { JobState } from "../../state.js";
import type { TaskDefinition, TaskId } from "../../types.js";
import { colored, fg, style, screen as scr } from "../ansi.js";
import { horizontalRule, wrapText } from "../format.js";
import { statusLabel } from "../symbols.js";
import type { KeyEvent } from "../screen.js";

export type TaskViewAction =
	| { type: "back" }
	| { type: "help" }
	| { type: "quit" };

export class TaskView {
	private scrollOffset = 0;

	constructor(
		readonly taskId: TaskId,
		private readonly taskDef: TaskDefinition | undefined,
	) {}

	handleInput(key: KeyEvent): TaskViewAction | undefined {
		switch (key.type) {
			case "escape":
			case "backspace":
				return { type: "back" };
			case "up":
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
				return undefined;
			case "down":
				this.scrollOffset++;
				return undefined;
			case "char":
				switch (key.char) {
					case "k": this.scrollOffset = Math.max(0, this.scrollOffset - 1); return undefined;
					case "j": this.scrollOffset++; return undefined;
					case "?": return { type: "help" };
					case "q": return { type: "quit" };
				}
				return undefined;
			default:
				return undefined;
		}
	}

	render(state: JobState, cols: number, rows: number): string {
		const contentLines: string[] = [];
		const ts = state.tasks.get(this.taskId);
		const status = ts?.status ?? "pending";
		const attempt = ts?.attemptCount ?? 0;

		contentLines.push(horizontalRule(cols, "─"));
		contentLines.push(
			colored(` Task: ${this.taskId} `, style.bold, fg.brightWhite)
			+ "  " + statusLabel(status)
			+ (attempt > 0 ? colored(`  attempt ${attempt}`, fg.yellow) : "")
		);
		contentLines.push(horizontalRule(cols, "─"));
		contentLines.push("");

		contentLines.push(colored("  Prompt:", style.bold, fg.cyan));
		contentLines.push("");
		const prompt = this.taskDef?.prompt ?? "(unknown)";
		const wrappedPrompt = wrapText(prompt, cols - 4);
		for (const line of wrappedPrompt) {
			contentLines.push("    " + line);
		}
		contentLines.push("");

		if (this.taskDef?.context && Object.keys(this.taskDef.context).length > 0) {
			contentLines.push(colored("  Context:", style.bold, fg.cyan));
			contentLines.push("");
			const ctxStr = JSON.stringify(this.taskDef.context, null, 2);
			for (const line of ctxStr.split("\n")) {
				contentLines.push("    " + line);
			}
			contentLines.push("");
		}

		contentLines.push(horizontalRule(cols, "─"));
		contentLines.push("");

		if (ts?.result) {
			const resultColor = ts.result.status === "success" ? fg.green : fg.red;
			contentLines.push(
				colored("  Result: ", style.bold, fg.cyan)
				+ colored(ts.result.status, resultColor, style.bold)
			);
			contentLines.push("");

			const wrappedSummary = wrapText(ts.result.summary, cols - 4);
			for (const line of wrappedSummary) {
				contentLines.push("    " + line);
			}
			contentLines.push("");

			if (ts.result.signals && Object.keys(ts.result.signals).length > 0) {
				contentLines.push(colored("  Signals:", style.bold, fg.gray));
				for (const [k, v] of Object.entries(ts.result.signals)) {
					contentLines.push(`    ${colored(k, fg.cyan)}: ${String(v)}`);
				}
				contentLines.push("");
			}

			if (ts.result.metrics && Object.keys(ts.result.metrics).length > 0) {
				contentLines.push(colored("  Metrics:", style.bold, fg.gray));
				for (const [k, v] of Object.entries(ts.result.metrics)) {
					contentLines.push(`    ${colored(k, fg.cyan)}: ${v}`);
				}
				contentLines.push("");
			}
		} else {
			contentLines.push(colored("  Result: ", style.bold, fg.cyan) + colored("(pending)", fg.gray));
			contentLines.push("");
		}

		contentLines.push(horizontalRule(cols, "─"));
		contentLines.push(this.renderFooter());

		const maxScroll = Math.max(0, contentLines.length - (rows - 1));
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + rows - 1);
		while (visible.length < rows - 1) visible.push("");

		return visible.map((l) => scr.clearLine + l).join("\n");
	}

	private renderFooter(): string {
		const keys: string[] = [];
		keys.push(colored("↑↓", fg.cyan) + " scroll");
		keys.push(colored("esc", fg.gray) + " back");
		keys.push(colored("?", fg.gray) + " help");
		keys.push(colored("q", fg.gray) + " quit");
		return " " + keys.join("  ");
	}
}
