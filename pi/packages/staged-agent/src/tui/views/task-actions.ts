import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import {
	colored, horizontalRule, FG_CYAN, FG_GRAY, FG_WHITE, FG_YELLOW, BOLD, DIM,
} from "../helpers.js";
import { clampCursor, parseNavKey, KeyState, renderFooter } from "../keybindings.js";

export type TaskActionMenuAction =
	| { type: "close" }
	| { type: "quit" }
	| { type: "transcript" }
	| { type: "fork_task" }
	| { type: "note" }
	| { type: "retry_with_note" }
	| { type: "pause_with_note" }
	| { type: "cancel_task" };

type ActionItem = {
	action: TaskActionMenuAction["type"];
	label: string;
	description: string;
};

export class TaskActionMenuView implements Component {
	private readonly keyState = new KeyState();
	private cursor = 0;
	onAction: ((action: TaskActionMenuAction) => void) | undefined;

	constructor(
		private readonly taskId: string,
		private readonly opts: {
			canCancel: boolean;
			canTranscript: boolean;
			canFork: boolean;
			canPauseWithNote: boolean;
			canRetryWithNote: boolean;
		},
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const nav = parseNavKey(data, this.keyState);
		const items = this.getItems();
		if (nav) {
			switch (nav.type) {
				case "up":
					this.cursor = clampCursor(this.cursor - 1, items.length);
					return;
				case "down":
					this.cursor = clampCursor(this.cursor + 1, items.length);
					return;
				case "top":
					this.cursor = 0;
					return;
				case "bottom":
					this.cursor = clampCursor(items.length - 1, items.length);
					return;
				case "enter": {
					const item = items[this.cursor];
					if (item) this.onAction?.({ type: item.action });
					return;
				}
				case "back":
					this.onAction?.({ type: "close" });
					return;
				case "help":
					return;
				case "quit":
					this.onAction?.({ type: "quit" });
					return;
				case "half_page_up":
				case "half_page_down":
					return;
			}
		}

		const directKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
		for (const [index, key] of directKeys.entries()) {
			if (matchesKey(data, key)) {
				this.triggerByIndex(index);
				return;
			}
		}
	}

	render(width: number): string[] {
		const items = this.getItems();
		const lines: string[] = [];
		const cardWidth = Math.max(40, Math.min(width, 92));

		lines.push(horizontalRule(cardWidth));
		lines.push(colored(`  Task actions · ${truncateToWidth(this.taskId, cardWidth - 18)}`, BOLD, FG_WHITE));
		lines.push(horizontalRule(cardWidth));
		lines.push("");
		lines.push(colored("  Modifier-first collaboration actions", FG_GRAY));
		lines.push(colored("  Use Alt-a to open this menu in task view.", FG_GRAY, DIM));
		lines.push("");

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const prefix = i === this.cursor
				? colored(" ▶ ", FG_CYAN, BOLD)
				: "   ";
			lines.push(
				prefix
				+ colored(`${i + 1}. ${item.label}`, FG_CYAN, BOLD)
				+ colored(`  ${item.description}`, FG_GRAY),
			);
		}

		lines.push("");
		lines.push(horizontalRule(cardWidth));
		lines.push(renderFooter([
			["j/k", "nav"],
			["enter", "run"],
			["1-9", "direct"],
			["esc", "close"],
			["q", "quit"],
		], { mode: "ACTIONS" }));
		return lines;
	}

	private triggerByIndex(index: number): void {
		const item = this.getItems()[index];
		if (item) this.onAction?.({ type: item.action });
	}

	private getItems(): ActionItem[] {
		const items: ActionItem[] = [
			{
				action: "note",
				label: "Add operator note",
				description: "Record a note in the task timeline.",
			},
		];
		if (this.opts.canFork) {
			items.push({
				action: "fork_task",
				label: "Fork as new task",
				description: "Spawn follow-up work using this task as context.",
			});
		}
		if (this.opts.canRetryWithNote) {
			items.push({
				action: "retry_with_note",
				label: "Interrupt and retry with note",
				description: "Cancel current attempt and restart with operator guidance.",
			});
		}
		if (this.opts.canPauseWithNote) {
			items.push({
				action: "pause_with_note",
				label: "Pause job after note",
				description: "Record context and pause orchestration for review.",
			});
		}
		if (this.opts.canTranscript) {
			items.push({
				action: "transcript",
				label: "Open transcript",
				description: "Inspect the task session transcript.",
			});
		}
		if (this.opts.canCancel) {
			items.push({
				action: "cancel_task",
				label: "Cancel running task",
				description: "Abort the active task attempt.",
			});
		}
		return items;
	}
}
