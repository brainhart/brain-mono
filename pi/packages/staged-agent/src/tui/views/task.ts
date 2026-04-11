import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { JobState, TaskAttemptRecord } from "../../state.js";
import type { TaskDefinition, TaskId } from "../../types.js";
import {
	colored, statusLabel, formatDuration, horizontalRule, statusIcon,
	FG_CYAN, FG_GRAY, FG_GREEN, FG_RED, FG_YELLOW, FG_WHITE, BOLD, DIM, visibleWidth,
} from "../helpers.js";
import { parseNavKey, KeyState, clampScroll, renderFooter } from "../keybindings.js";
import { ProgressFeed } from "./progress-feed.js";
import { renderTranscriptEntries, type TranscriptEntry } from "./transcript.js";

export type TaskViewAction =
	| { type: "back" }
	| { type: "open_actions"; taskId: string }
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
	private transcriptEntries: TranscriptEntry[] = [];
	private transcriptCwd: string | undefined;
	private transcriptSessionLabel: string | undefined;
	private transcriptLoading = false;
	private transcriptError: string | undefined;
	onAction: ((action: TaskViewAction) => void) | undefined;

	constructor(
		readonly taskId: TaskId,
		private readonly taskDef: TaskDefinition | undefined,
		breadcrumb?: string,
	) {
		this.breadcrumb = breadcrumb ?? `Job → … → ${taskId}`;
	}

	setState(state: JobState): void { this.state = state; }
	setTranscriptLoading(sessionLabel: string): void {
		this.transcriptEntries = [];
		this.transcriptSessionLabel = sessionLabel;
		this.transcriptLoading = true;
		this.transcriptError = undefined;
	}
	setTranscriptEntries(entries: TranscriptEntry[], sessionLabel: string, cwd?: string): void {
		this.transcriptEntries = entries;
		this.transcriptCwd = cwd;
		this.transcriptSessionLabel = sessionLabel;
		this.transcriptLoading = false;
		this.transcriptError = undefined;
	}
	setTranscriptError(error: string, sessionLabel: string): void {
		this.transcriptEntries = [];
		this.transcriptCwd = undefined;
		this.transcriptSessionLabel = sessionLabel;
		this.transcriptLoading = false;
		this.transcriptError = error;
	}
	clearTranscript(): void {
		this.transcriptEntries = [];
		this.transcriptCwd = undefined;
		this.transcriptSessionLabel = undefined;
		this.transcriptLoading = false;
		this.transcriptError = undefined;
	}
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

		if (matchesKey(data, ":") || data === "\x1ba") {
			this.onAction?.({ type: "open_actions", taskId: this.taskId });
		} else if (matchesKey(data, "t")) {
			const ts = this.state?.tasks.get(this.taskId);
			if (ts?.result?.signals) {
				const sessionFile = ts.result.signals.sessionFile as string | undefined;
				const sessionId = ts.result.signals.sessionId as string | undefined ?? ts.sessionId;
				if (sessionFile) {
					this.onAction?.({ type: "view_transcript", taskId: this.taskId, sessionFile, sessionId });
				}
			}
		} else if (matchesKey(data, "x")) {
			const ts = this.state?.tasks.get(this.taskId);
			if (ts?.status === "running" && ts.stageId) {
				this.onAction?.({ type: "cancel_task", taskId: this.taskId, stageId: ts.stageId });
			}
		}
	}

	render(width: number): string[] {
		const state = this.state;
		if (!state) return ["(no state)"];

		const lines: string[] = [];
		const ts = state.tasks.get(this.taskId);
		const runtimeSessionId = ts?.result?.signals?.sessionId as string | undefined;
		const displaySessionId = runtimeSessionId ?? ts?.sessionId;
		const status = ts?.status ?? "pending";
		const attempt = ts?.attemptCount ?? 0;
		const now = Date.now();

		lines.push(...wrapTextWithAnsi(colored(` ${this.breadcrumb}`, FG_GRAY, DIM), Math.max(1, width)));
		lines.push(horizontalRule(width));

		let timeStr = "";
		if (ts?.startedAt) {
			const end = ts.completedAt ?? now;
			timeStr = "  " + colored(formatDuration(end - ts.startedAt), FG_GRAY);
		}

		const headerLine =
			colored(` Task: ${this.taskId} `, BOLD, FG_WHITE)
			+ "  " + statusLabel(status)
			+ (attempt > 0 ? colored(`  attempt ${attempt}`, FG_YELLOW) : "")
			+ timeStr;
		lines.push(...wrapTextWithAnsi(headerLine, Math.max(1, width)));
		if (displaySessionId) {
			lines.push(...wrapTextWithAnsi(colored(`  session: ${displaySessionId}`, FG_GRAY, DIM), Math.max(1, width)));
		}
		lines.push(horizontalRule(width));
		lines.push("");

		lines.push(colored("  Prompt:", BOLD, FG_CYAN));
		lines.push("");
		const prompt = this.taskDef?.prompt ?? "(unknown)";
		lines.push(...this.renderIndentedBlock(prompt, width, 4));
		lines.push("");

		if (this.taskDef?.context && Object.keys(this.taskDef.context).length > 0) {
			lines.push(colored("  Context:", BOLD, FG_CYAN));
			lines.push("");
			const ctxStr = JSON.stringify(this.taskDef.context, null, 2);
			lines.push(...this.renderIndentedBlock(ctxStr, width, 4));
			lines.push("");
		}

		if (ts && ts.progressEntries.length > 0) {
			const feed = new ProgressFeed();
			feed.setEntries(ts.progressEntries);
			lines.push(...feed.render(width));
		}

		if (ts && ts.operatorNotes.length > 0) {
			lines.push(horizontalRule(width));
			lines.push(colored("  Operator notes:", BOLD, FG_CYAN));
			lines.push("");
			const notes = ts.operatorNotes.slice(-4);
			for (const entry of notes) {
				const label = entry.action === "retry"
					? "retry"
					: entry.action === "pause"
						? "pause"
						: "note";
				const wrapped = wrapTextWithAnsi(entry.note, Math.max(1, width - 12));
				lines.push(`    ${colored(`[${label}]`, FG_YELLOW)} ${wrapped[0] ?? ""}`);
				for (const line of wrapped.slice(1)) {
					lines.push(`            ${line}`);
				}
			}
			lines.push("");
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
			lines.push(...this.renderIndentedBlock(ts.result.summary, width, 4));
			lines.push("");

			if (ts.result.signals && Object.keys(ts.result.signals).length > 0) {
				lines.push(colored("  Signals:", BOLD, FG_GRAY));
				lines.push(...Object.entries(ts.result.signals).flatMap(([k, v]) =>
					this.renderKeyValueEntry(k, this.formatValue(v), width),
				));
				lines.push("");
			}

			if (ts.result.metrics && Object.keys(ts.result.metrics).length > 0) {
				lines.push(colored("  Metrics:", BOLD, FG_GRAY));
				lines.push(...Object.entries(ts.result.metrics).flatMap(([k, v]) =>
					this.renderKeyValueEntry(k, String(v), width),
				));
				lines.push("");
			}
		} else if (ts?.error) {
			lines.push(...wrapTextWithAnsi(
				colored("  Error: ", BOLD, FG_RED) + colored(ts.error, FG_RED),
				Math.max(1, width),
			));
			lines.push("");
		} else {
			lines.push(colored("  Result: ", BOLD, FG_CYAN) + colored("(pending)", FG_GRAY));
			lines.push("");
		}

		if (this.shouldRenderTranscriptSection()) {
			lines.push(horizontalRule(width));
			const sessionLabel = this.transcriptSessionLabel
				? colored(`  ${truncateToWidth(this.transcriptSessionLabel, Math.max(1, width - 18))}`, FG_GRAY, DIM)
				: "";
			lines.push(colored("  Pi session log", BOLD, FG_CYAN) + sessionLabel);
			lines.push("");
			if (this.transcriptLoading) {
				lines.push(colored("    Loading transcript…", FG_GRAY));
				lines.push("");
			} else if (this.transcriptError) {
				lines.push(...this.renderIndentedBlock(this.transcriptError, width, 4, FG_RED));
				lines.push("");
			} else if (this.transcriptEntries.length === 0) {
				lines.push(colored("    No transcript entries found", FG_GRAY));
				lines.push("");
			} else {
				lines.push(...renderTranscriptEntries(this.transcriptEntries, width, { cwd: this.transcriptCwd }));
			}
		}

		if (ts && ts.attempts.length > 1) {
			lines.push(horizontalRule(width));
			lines.push(colored("  Attempt History:", BOLD, FG_CYAN));
			lines.push("");
			for (const a of ts.attempts) {
				lines.push(...this.renderAttemptLines(a, now, width));
			}
			lines.push("");
		}

		lines.push(horizontalRule(width));
		const footerKeys: Array<[string, string]> = [["j/k", "scroll"], ["gg/G", "top/bot"], ["C-d/u", "page"]];
		footerKeys.push(["Alt-a", "actions"]);
		if (typeof ts?.result?.signals?.sessionFile === "string") footerKeys.push(["t", "transcript"]);
		if (ts?.status === "running") footerKeys.push(["x", "cancel"]);
		footerKeys.push(["h/esc", "back"], ["?", "help"], ["q", "quit"]);
		lines.push(renderFooter(footerKeys, { mode: "NORMAL" }));

		this.contentHeight = lines.length;
		const maxScroll = Math.max(0, lines.length - 1);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		return this.scrollOffset > 0 ? lines.slice(this.scrollOffset) : lines;
	}

	private renderAttemptLines(a: TaskAttemptRecord, now: number, width: number): string[] {
		const lines: string[] = [];
		const dur = a.finishedAt
			? formatDuration(a.finishedAt - a.startedAt)
			: formatDuration(now - a.startedAt) + "…";

		let statusStr: string;
		if (a.result) statusStr = a.result.status === "success" ? statusIcon("completed") : statusIcon("failed");
		else if (a.error) statusStr = statusIcon("failed");
		else statusStr = statusIcon("running");

		const header = `    ${statusStr} #${a.attemptNumber}  ${colored(dur, FG_GRAY)}`;
		lines.push(...wrapTextWithAnsi(header, Math.max(1, width)));
		if (a.sessionId) {
			lines.push(...this.renderKeyValueEntry("session", a.sessionId, width, 6));
		}
		if (a.error) {
			lines.push(...this.renderKeyValueEntry("error", a.error, width, 6, FG_RED));
		} else if (a.result?.status === "failure") {
			lines.push(...this.renderKeyValueEntry("summary", a.result.summary, width, 6, FG_RED));
		}
		lines.push("");
		return lines;
	}

	private shouldRenderTranscriptSection(): boolean {
		return this.transcriptLoading
			|| this.transcriptError !== undefined
			|| this.transcriptEntries.length > 0
			|| this.transcriptSessionLabel !== undefined;
	}

	private formatValue(value: unknown): string {
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
			return String(value);
		}
		if (value === null) return "null";
		if (value === undefined) return "undefined";
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}

	private renderIndentedBlock(text: string, width: number, indent: number, color?: string): string[] {
		const lines: string[] = [];
		const prefix = " ".repeat(indent);
		for (const rawLine of text.split("\n")) {
			if (rawLine.length === 0) {
				lines.push(prefix);
				continue;
			}
			const source = color ? colored(rawLine, color) : rawLine;
			const wrapped = wrapTextWithAnsi(source, Math.max(1, width - indent));
			for (const line of wrapped) {
				lines.push(prefix + line);
			}
		}
		return lines;
	}

	private renderKeyValueEntry(
		key: string,
		value: string,
		width: number,
		indent = 4,
		valueColor?: string,
	): string[] {
		const lines: string[] = [];
		const plainPrefix = `${" ".repeat(indent)}${key}: `;
		const coloredPrefix = `${" ".repeat(indent)}${colored(key, FG_CYAN)}: `;
		const continuationPrefix = " ".repeat(visibleWidth(plainPrefix));
		const rawLines = value.split("\n");
		let firstVisualLine = true;
		for (const rawLine of rawLines) {
			const source = valueColor ? colored(rawLine, valueColor) : rawLine;
			const wrapped = rawLine.length === 0
				? [""]
				: wrapTextWithAnsi(source, Math.max(1, width - visibleWidth(plainPrefix)));
			for (const [index, segment] of wrapped.entries()) {
				if (firstVisualLine) {
					lines.push(coloredPrefix + segment);
					firstVisualLine = false;
					continue;
				}
				lines.push((index === 0 ? continuationPrefix : continuationPrefix) + segment);
			}
		}
		if (firstVisualLine) {
			lines.push(coloredPrefix);
		}
		return lines;
	}
}
