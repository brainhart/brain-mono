import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import {
	colored, horizontalRule, FG_CYAN, FG_GRAY, FG_RED, FG_WHITE, BOLD, DIM,
} from "../helpers.js";
import { renderFooter } from "../keybindings.js";

export type TextPromptAction =
	| { type: "cancel" }
	| { type: "submit"; value: string };

export class TextPromptView implements Component {
	private value = "";
	private error: string | undefined;
	onAction: ((action: TextPromptAction) => void) | undefined;

	constructor(
		private readonly title: string,
		private readonly prompt: string,
		private readonly placeholder?: string,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onAction?.({ type: "cancel" });
			return;
		}
		if (matchesKey(data, "enter")) {
			const value = this.value.trim();
			if (!value) {
				this.error = "Enter a short note to continue.";
				return;
			}
			this.onAction?.({ type: "submit", value });
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.value = this.value.slice(0, -1);
			this.error = undefined;
			return;
		}
		if (data >= " " && data !== "\x7f" && !data.startsWith("\x1b")) {
			this.value += data;
			this.error = undefined;
		}
	}

	render(width: number): string[] {
		const cardWidth = Math.max(48, Math.min(width, 96));
		const lines: string[] = [];
		lines.push(horizontalRule(cardWidth));
		lines.push(colored(`  ${truncateToWidth(this.title, cardWidth - 4)}`, BOLD, FG_WHITE));
		lines.push(horizontalRule(cardWidth));
		lines.push("");
		lines.push(colored(`  ${this.prompt}`, FG_GRAY));
		lines.push("");
		lines.push(colored("  Note:", FG_CYAN, BOLD));
		lines.push("");
		lines.push(`    ${this.value || colored(this.placeholder ?? "(type a note)", FG_GRAY, DIM)}`);
		if (this.error) {
			lines.push("");
			lines.push(colored(`  ${this.error}`, FG_RED));
		}
		lines.push("");
		lines.push(horizontalRule(cardWidth));
		lines.push(renderFooter([
			["type", "edit"],
			["enter", "submit"],
			["esc", "cancel"],
		], { mode: "INPUT" }));
		return lines;
	}
}
