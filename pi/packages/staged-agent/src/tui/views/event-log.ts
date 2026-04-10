import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { RuntimeEvent } from "../../events.js";
import {
	colored, formatDuration, horizontalRule,
	FG_CYAN, FG_GRAY, FG_GREEN, FG_RED, FG_YELLOW, FG_WHITE, BOLD, DIM,
} from "../helpers.js";
import { parseNavKey, KeyState, clampScroll, renderFooter } from "../keybindings.js";

export type EventLogViewAction =
	| { type: "back" }
	| { type: "help" }
	| { type: "quit" };

export class EventLogView implements Component {
	private events: RuntimeEvent[] = [];
	private scrollOffset = 0;
	private readonly keyState = new KeyState();
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
		const nav = parseNavKey(data, this.keyState);
		if (nav) {
			switch (nav.type) {
				case "up":   this.scrollOffset = clampScroll(this.scrollOffset - 1, this.events.length); this.autoScroll = false; return;
				case "down": this.scrollOffset = clampScroll(this.scrollOffset + 1, this.events.length); if (this.scrollOffset >= this.events.length - 10) this.autoScroll = true; return;
				case "top":  this.scrollOffset = 0; this.autoScroll = false; return;
				case "bottom": this.scrollOffset = Math.max(0, this.events.length - 10); this.autoScroll = true; return;
				case "half_page_up":   this.scrollOffset = clampScroll(this.scrollOffset - 15, this.events.length); this.autoScroll = false; return;
				case "half_page_down": this.scrollOffset = clampScroll(this.scrollOffset + 15, this.events.length); if (this.scrollOffset >= this.events.length - 10) this.autoScroll = true; return;
				case "back":  this.onAction?.({ type: "back" }); return;
				case "help":  this.onAction?.({ type: "help" }); return;
				case "quit":  this.onAction?.({ type: "quit" }); return;
				case "enter": return;
			}
		}

		if (matchesKey(data, "shift+l")) this.onAction?.({ type: "back" });
	}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push(horizontalRule(width));
		lines.push(
			colored(" Event Log", BOLD, FG_WHITE)
			+ "  " + colored(`${this.events.length} events`, FG_GRAY)
			+ (this.autoScroll ? colored("  (tail)", FG_CYAN, DIM) : ""),
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
		lines.push(renderFooter([["j/k", "scroll"], ["gg/G", "top/tail"], ["C-d/u", "page"], ["h/esc", "back"], ["q", "quit"]], { mode: "NORMAL" }));
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
			case "task_progress": {
				const p = event.progress;
				const kind = colored(p.kind, FG_GRAY);
				const text = p.text ? truncateToWidth(p.text, maxWidth - 30) : (p.toolName ?? "");
				return colored("progress", FG_GRAY, DIM) + ` ${event.taskId} ${kind} ${text}`;
			}
			case "session_attached":
				return colored("session", FG_GRAY) + colored(` ${event.sessionId} → ${event.taskAttemptId}`, FG_GRAY, DIM);
			case "transition_evaluated": {
				let detail = colored("transition", FG_YELLOW) + colored(` ${event.parentStageId} → ${event.childStageId}`, FG_WHITE);
				if (event.addedStages.length > 0) detail += colored(` +${event.addedStages.join(",")}`, FG_GREEN);
				if (event.resetStages.length > 0) detail += colored(` ↻${event.resetStages.join(",")}`, FG_YELLOW);
				return detail;
			}
			default:
				return colored((event as { type: string }).type, FG_GRAY);
		}
	}
}
