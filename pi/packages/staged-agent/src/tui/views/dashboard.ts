import type { JobState, StageState } from "../../state.js";
import type { JobDefinition, StageId } from "../../types.js";
import { colored, fg, style, screen as scr } from "../ansi.js";
import { formatDuration, horizontalRule, padRight, truncate } from "../format.js";
import { statusIcon, statusLabel } from "../symbols.js";
import type { KeyEvent } from "../screen.js";

export type DashboardAction =
	| { type: "drill_stage"; stageId: StageId }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "cancel" }
	| { type: "help" }
	| { type: "quit" };

export class DashboardView {
	private cursor = 0;
	private stageIds: StageId[] = [];

	constructor(private readonly definition: JobDefinition) {
		this.stageIds = definition.stages.map((s) => s.id);
	}

	handleInput(key: KeyEvent): DashboardAction | undefined {
		switch (key.type) {
			case "up":
				this.cursor = Math.max(0, this.cursor - 1);
				return undefined;
			case "down":
				this.cursor = Math.min(this.stageIds.length - 1, this.cursor + 1);
				return undefined;
			case "enter":
				if (this.stageIds.length > 0) {
					return { type: "drill_stage", stageId: this.stageIds[this.cursor] };
				}
				return undefined;
			case "char":
				switch (key.char) {
					case "k": this.cursor = Math.max(0, this.cursor - 1); return undefined;
					case "j": this.cursor = Math.min(this.stageIds.length - 1, this.cursor + 1); return undefined;
					case "p": return { type: "pause" };
					case "r": return { type: "resume" };
					case "c": return { type: "cancel" };
					case "?": return { type: "help" };
					case "q": return { type: "quit" };
				}
				return undefined;
			default:
				return undefined;
		}
	}

	render(state: JobState, cols: number, rows: number, startTime: number): string {
		const lines: string[] = [];
		const now = Date.now();
		const elapsed = formatDuration(now - startTime);

		const title = colored(
			` Job ${truncate(state.jobId, 20)} `,
			style.bold,
			fg.brightWhite,
		);
		const statusStr = statusLabel(state.status);

		lines.push(horizontalRule(cols, "─"));
		lines.push(`${title}  ${statusStr}  ${colored(elapsed, fg.gray)}`);
		lines.push(horizontalRule(cols, "─"));
		lines.push("");

		if (this.stageIds.length !== this.definition.stages.length) {
			this.stageIds = this.definition.stages.map((s) => s.id);
		}

		const dynStageIds = [...state.stages.keys()].filter(
			(id) => !this.stageIds.includes(id),
		);
		const allStageIds = [...this.stageIds, ...dynStageIds];
		this.stageIds = allStageIds;

		for (let i = 0; i < allStageIds.length; i++) {
			const sid = allStageIds[i];
			const ss = state.stages.get(sid);
			const line = this.renderStageLine(sid, ss, cols, now);
			const prefix = i === this.cursor
				? colored(" ▶ ", fg.cyan, style.bold)
				: "   ";
			lines.push(prefix + line);
		}

		lines.push("");
		lines.push(horizontalRule(cols, "─"));
		lines.push(this.renderFooter(state.status));

		const maxLines = rows - 1;
		while (lines.length < maxLines) lines.push("");
		if (lines.length > maxLines) lines.length = maxLines;

		return lines.map((l) => scr.clearLine + l).join("\n");
	}

	private renderStageLine(
		stageId: StageId,
		ss: StageState | undefined,
		cols: number,
		_now: number,
	): string {
		const status = ss?.status ?? "waiting";
		const icon = statusIcon(status);
		const stageDef = this.definition.stages.find((s) => s.id === stageId);
		const name = stageDef?.name ?? stageId;
		const taskCount = stageDef?.tasks.length ?? 0;
		const completedTasks = this.countCompletedTasks(stageId, ss);
		const attempt = ss?.attemptCount ?? 0;

		let info = `${completedTasks}/${taskCount} tasks`;
		if (attempt > 1) {
			info += colored(`  attempt ${attempt}`, fg.yellow);
		}

		const maxName = Math.min(30, Math.floor(cols * 0.3));
		const nameStr = padRight(truncate(name, maxName), maxName);
		return `[${icon}] ${nameStr}  ${info}`;
	}

	private countCompletedTasks(stageId: StageId, _ss: StageState | undefined): number {
		return 0;
	}

	private renderFooter(jobStatus: string): string {
		const keys: string[] = [];
		keys.push(colored("↑↓", fg.cyan) + " navigate");
		keys.push(colored("enter", fg.cyan) + " drill-down");
		if (jobStatus === "running") {
			keys.push(colored("p", fg.yellow) + " pause");
			keys.push(colored("c", fg.red) + " cancel");
		}
		if (jobStatus === "paused") {
			keys.push(colored("r", fg.green) + " resume");
			keys.push(colored("c", fg.red) + " cancel");
		}
		keys.push(colored("?", fg.gray) + " help");
		keys.push(colored("q", fg.gray) + " quit");
		return " " + keys.join("  ");
	}
}
