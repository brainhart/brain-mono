import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { RuntimeEvent } from "../../events.js";
import {
	colored, formatDuration, horizontalRule,
	FG_CYAN, FG_GRAY, FG_GREEN, FG_RED, FG_YELLOW, FG_WHITE, BOLD, DIM,
} from "../helpers.js";

export type EventLogViewAction =
	| { type: "back" }
	| { type: "help" }
	| { type: "quit" };

/**
 * Live scrollable feed of runtime events.
 * Shows what the system is doing as it happens — stage transitions,
 * task starts/completions, session attachments, transition evaluations.
 */
export class EventLogView implements Component {
	private events: RuntimeEvent[] = [];
	private scrollOffset = 0;
	private autoScroll = true;
	private jobStartTime = 0;
	onAction: ((action: EventLogViewAction) => void) | undefined;

	setEvents(events: readonly RuntimeEvent[]): void {
		this.events = [...events];
		if (this.events.length > 0 && this.jobStartTime === 0) {
			this.jobStartTime = this.events[0].timestamp;
		}
		if (this.autoScroll) {
			this.scrollOffset = Math.max(0, this.events.length - 10);
		}
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "backspace") || matchesKey(data, "l")) {
			this.onAction?.({ type: "back" });
		} else if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = false;
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.scrollOffset = Math.min(Math.max(0, this.events.length - 1), this.scrollOffset + 1);
			if (this.events.length === 0 || this.scrollOffset >= this.events.length - 10) this.autoScroll = true;
		} else if (matchesKey(data, "g")) {
			this.scrollOffset = Math.max(0, this.events.length - 10);
			this.autoScroll = true;
		} else if (matchesKey(data, "?")) {
			this.onAction?.({ type: "help" });
		} else if (matchesKey(data, "q")) {
			this.onAction?.({ type: "quit" });
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push(horizontalRule(width));
		lines.push(
			colored(" Event Log", BOLD, FG_WHITE)
			+ "  " + colored(`${this.events.length} events`, FG_GRAY)
			+ (this.autoScroll ? colored("  (auto-scroll)", FG_CYAN, DIM) : ""),
		);
		lines.push(horizontalRule(width));
		lines.push("");

		if (this.events.length === 0) {
			lines.push(colored("  No events yet", FG_GRAY));
		} else {
			const visible = this.events.slice(this.scrollOffset, this.scrollOffset + 30);
			for (const event of visible) {
				lines.push(this.renderEvent(event, width));
			}
		}

		lines.push("");
		lines.push(horizontalRule(width));
		lines.push(this.renderFooter());
		return lines;
	}

	private renderEvent(event: RuntimeEvent, width: number): string {
		const relTime = this.jobStartTime > 0
			? formatDuration(event.timestamp - this.jobStartTime)
			: "0ms";
		const timeStr = colored(`  ${relTime.padStart(8)}`, FG_GRAY, DIM);

		const detail = this.formatEventDetail(event, width - 20);
		return `${timeStr}  ${detail}`;
	}

	private formatEventDetail(event: RuntimeEvent, maxWidth: number): string {
		switch (event.type) {
			case "job_submitted":
				return colored("job_submitted", FG_GREEN) + colored(` ${event.stageIds.length} stages`, FG_GRAY);
			case "job_completed":
				return colored("job_completed", FG_GREEN, BOLD);
			case "job_failed":
				return colored("job_failed", FG_RED, BOLD) + colored(` ${truncateToWidth(event.error, maxWidth - 20)}`, FG_RED);
			case "job_paused":
				return colored("job_paused", FG_YELLOW, BOLD) + (event.reason ? colored(` "${event.reason}"`, FG_YELLOW) : "");
			case "job_resumed":
				return colored("job_resumed", FG_GREEN) + (event.input ? colored(` input: "${truncateToWidth(event.input, maxWidth - 25)}"`, FG_GRAY) : "");
			case "stage_submitted":
				return colored("stage_submitted", FG_CYAN) + colored(` ${event.stageId}`, FG_WHITE);
			case "stage_completed":
				return colored("stage_completed", FG_GREEN) + colored(` ${event.stageId}`, FG_WHITE);
			case "stage_failed":
				return colored("stage_failed", FG_RED) + colored(` ${event.stageId}`, FG_WHITE) + colored(` ${truncateToWidth(event.error, maxWidth - 30)}`, FG_RED);
			case "stage_reset":
				return colored("stage_reset", FG_YELLOW) + colored(` ${event.stageId}`, FG_WHITE);
			case "stage_attempt_started":
				return colored("attempt_start", FG_CYAN) + colored(` ${event.stageId} #${event.attemptNumber}`, FG_WHITE);
			case "stage_attempt_completed":
				return colored("attempt_done", FG_GREEN) + colored(` ${event.stageId}`, FG_WHITE);
			case "stage_attempt_failed":
				return colored("attempt_fail", FG_RED) + colored(` ${event.stageId}`, FG_WHITE);
			case "task_started":
				return colored("task_started", FG_CYAN) + colored(` ${event.taskId}`, FG_WHITE) + colored(` #${event.attemptNumber}`, FG_GRAY);
			case "task_completed": {
				const s = event.result.status === "success" ? FG_GREEN : FG_RED;
				return colored("task_completed", s) + colored(` ${event.taskId}`, FG_WHITE) + colored(` [${event.result.status}]`, s);
			}
			case "task_failed":
				return colored("task_failed", FG_RED) + colored(` ${event.taskId}`, FG_WHITE) + colored(` ${truncateToWidth(event.error, maxWidth - 30)}`, FG_RED);
			case "session_attached":
				return colored("session", FG_GRAY) + colored(` ${event.sessionId} → ${event.taskAttemptId}`, FG_GRAY, DIM);
			case "task_progress": {
				const p = event.progress;
				const kind = colored(p.kind, FG_GRAY);
				const text = p.text ? truncateToWidth(p.text, maxWidth - 30) : (p.toolName ?? "");
				return colored("progress", FG_GRAY, DIM) + ` ${event.taskId} ${kind} ${text}`;
			}
			case "transition_evaluated": {
				let detail = colored("transition", FG_YELLOW) + colored(` ${event.parentStageId} → ${event.childStageId}`, FG_WHITE);
				if (event.addedStages.length > 0) detail += colored(` +${event.addedStages.join(",")}`, FG_GREEN);
				if (event.resetStages.length > 0) detail += colored(` ↻${event.resetStages.join(",")}`, FG_YELLOW);
				return detail;
			}
		}
	}

	private renderFooter(): string {
		const keys: string[] = [];
		keys.push(colored("↑↓", FG_CYAN) + " scroll");
		keys.push(colored("g", FG_CYAN) + " tail");
		keys.push(colored("esc/l", FG_GRAY) + " back");
		keys.push(colored("q", FG_GRAY) + " quit");
		return " " + keys.join("  ");
	}
}
