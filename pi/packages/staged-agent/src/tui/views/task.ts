import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { JobState, TaskAttemptRecord } from "../../state.js";
import type { TaskDefinition, TaskId } from "../../types.js";
import {
	colored, statusLabel, formatDuration, horizontalRule, statusIcon,
	FG_CYAN, FG_GRAY, FG_GREEN, FG_RED, FG_YELLOW, FG_WHITE, BOLD, DIM,
} from "../helpers.js";
import { parseNavKey, KeyState, clampScroll, renderFooter } from "../keybindings.js";
import { ProgressFeed } from "./progress-feed.js";

export type TaskViewAction =
	| { type: "back" }
	| { type: "cancel_task"; taskId: string; stageId: string }
	| { type: "view_transcript"; taskId: string; sessionFile?: string; sessionId?: string }
	| { type: "help" }
	| { type: "quit" };

export class TaskView implements Component {
	private scrollOffset = 0;
	private contentHeight = 0;
	private readonly keyState = new KeyState();
	private state: JobState | undefined;
	private breadcrumb: string;
	onAction: ((action: TaskViewAction) => void) | undefined;

	constructor(
		readonly taskId: TaskId,
		private readonly taskDef: TaskDefinition | undefined,
		breadcrumb?: string,
	) {
		this.breadcrumb = breadcrumb ?? `Job → … → ${taskId}`;
	}

	setState(state: JobState): void { this.state = state; }
	invalidate(): void {}

	handleInput(data: string): void {
		const nav = parseNavKey(data, this.keyState);
		if (nav) {
			switch (nav.type) {
				case "up":   case "back": {
					if (nav.type === "up") { this.scrollOffset = clampScroll(this.scrollOffset - 1, this.contentHeight); return; }
					this.onAction?.({ type: "back" }); return;
				}
				case "down":  this.scrollOffset = clampScroll(this.scrollOffset + 1, this.contentHeight); return;
				case "top":   this.scrollOffset = 0; return;
				case "bottom": this.scrollOffset = clampScroll(this.contentHeight, this.contentHeight); return;
				case "half_page_up":   this.scrollOffset = clampScroll(this.scrollOffset - 15, this.contentHeight); return;
				case "half_page_down": this.scrollOffset = clampScroll(this.scrollOffset + 15, this.contentHeight); return;
				case "enter": return;
				case "help":  this.onAction?.({ type: "help" }); return;
				case "quit":  this.onAction?.({ type: "quit" }); return;
			}
		}

		if (matchesKey(data, "x")) {
			const ts = this.state?.tasks.get(this.taskId);
			if (ts?.status === "running" && ts.stageId) {
				this.onAction?.({ type: "cancel_task", taskId: this.taskId, stageId: ts.stageId });
			}
		} else if (matchesKey(data, "t")) {
			const ts = this.state?.tasks.get(this.taskId);
			if (ts?.result?.signals) {
				const sessionFile = ts.result.signals.sessionFile as string | undefined;
				const sessionId = ts.sessionId ?? ts.result.signals.sessionId as string | undefined;
				if (sessionFile || sessionId) {
					this.onAction?.({ type: "view_transcript", taskId: this.taskId, sessionFile, sessionId });
				}
			}
		}
	}

	render(width: number): string[] {
		const state = this.state;
		if (!state) return ["(no state)"];

		const lines: string[] = [];
		const ts = state.tasks.get(this.taskId);
		const status = ts?.status ?? "pending";
		const attempt = ts?.attemptCount ?? 0;
		const now = Date.now();

		lines.push(colored(` ${this.breadcrumb}`, FG_GRAY, DIM));
		lines.push(horizontalRule(width));

		let timeStr = "";
		if (ts?.startedAt) {
			const end = ts.completedAt ?? now;
			timeStr = "  " + colored(formatDuration(end - ts.startedAt), FG_GRAY);
		}

		lines.push(
			colored(` Task: ${this.taskId} `, BOLD, FG_WHITE)
			+ "  " + statusLabel(status)
			+ (attempt > 0 ? colored(`  attempt ${attempt}`, FG_YELLOW) : "")
			+ timeStr,
		);
		if (ts?.sessionId) {
			lines.push(colored(`  session: ${ts.sessionId}`, FG_GRAY, DIM));
		}
		lines.push(horizontalRule(width));
		lines.push("");

		lines.push(colored("  Prompt:", BOLD, FG_CYAN));
		lines.push("");
		const prompt = this.taskDef?.prompt ?? "(unknown)";
		const wrappedPrompt = wrapTextWithAnsi(prompt, Math.max(1, width - 4));
		for (const line of wrappedPrompt) lines.push("    " + line);
		lines.push("");

		if (this.taskDef?.context && Object.keys(this.taskDef.context).length > 0) {
			lines.push(colored("  Context:", BOLD, FG_CYAN));
			lines.push("");
			const ctxStr = JSON.stringify(this.taskDef.context, null, 2);
			for (const line of ctxStr.split("\n")) lines.push("    " + line);
			lines.push("");
		}

		if (ts && ts.progressEntries.length > 0) {
			const feed = new ProgressFeed();
			feed.setEntries(ts.progressEntries);
			lines.push(...feed.render(width));
		}

		lines.push(horizontalRule(width));
		lines.push("");

		if (ts?.result) {
			const resultColor = ts.result.status === "success" ? FG_GREEN : FG_RED;
			lines.push(
				colored("  Result: ", BOLD, FG_CYAN)
				+ colored(ts.result.status, resultColor, BOLD),
			);
			lines.push("");
			const wrappedSummary = wrapTextWithAnsi(ts.result.summary, Math.max(1, width - 4));
			for (const line of wrappedSummary) lines.push("    " + line);
			lines.push("");

			if (ts.result.signals && Object.keys(ts.result.signals).length > 0) {
				lines.push(colored("  Signals:", BOLD, FG_GRAY));
				for (const [k, v] of Object.entries(ts.result.signals)) {
					lines.push(`    ${colored(k, FG_CYAN)}: ${String(v)}`);
				}
				lines.push("");
			}

			if (ts.result.metrics && Object.keys(ts.result.metrics).length > 0) {
				lines.push(colored("  Metrics:", BOLD, FG_GRAY));
				for (const [k, v] of Object.entries(ts.result.metrics)) {
					lines.push(`    ${colored(k, FG_CYAN)}: ${v}`);
				}
				lines.push("");
			}
		} else if (ts?.error) {
			lines.push(colored("  Error: ", BOLD, FG_RED) + colored(ts.error, FG_RED));
			lines.push("");
		} else {
			lines.push(colored("  Result: ", BOLD, FG_CYAN) + colored("(pending)", FG_GRAY));
			lines.push("");
		}

		if (ts && ts.attempts.length > 1) {
			lines.push(horizontalRule(width));
			lines.push(colored("  Attempt History:", BOLD, FG_CYAN));
			lines.push("");
			for (const a of ts.attempts) {
				lines.push(this.renderAttemptLine(a, now));
			}
			lines.push("");
		}

		lines.push(horizontalRule(width));
		const footerKeys: Array<[string, string]> = [["j/k", "scroll"], ["gg/G", "top/bot"], ["C-d/u", "page"]];
		if (ts?.status === "running") footerKeys.push(["x", "cancel"]);
		if (ts?.result?.signals?.sessionFile || ts?.sessionId) footerKeys.push(["t", "transcript"]);
		footerKeys.push(["h/esc", "back"], ["?", "help"], ["q", "quit"]);
		lines.push(renderFooter(footerKeys, { mode: "NORMAL" }));

		this.contentHeight = lines.length;
		const maxScroll = Math.max(0, lines.length - 1);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		return this.scrollOffset > 0 ? lines.slice(this.scrollOffset) : lines;
	}

	private renderAttemptLine(a: TaskAttemptRecord, now: number): string {
		const dur = a.finishedAt
			? formatDuration(a.finishedAt - a.startedAt)
			: formatDuration(now - a.startedAt) + "…";

		let statusStr: string;
		if (a.result) statusStr = a.result.status === "success" ? statusIcon("completed") : statusIcon("failed");
		else if (a.error) statusStr = statusIcon("failed");
		else statusStr = statusIcon("running");

		let detail = "";
		if (a.error) detail = colored(` ${a.error}`, FG_RED);
		else if (a.result?.status === "failure") detail = colored(` ${a.result.summary}`, FG_RED);
		if (a.sessionId) detail += colored(` [${a.sessionId}]`, FG_GRAY, DIM);

		return `    ${statusStr} #${a.attemptNumber}  ${colored(dur, FG_GRAY)}${detail}`;
	}
}
