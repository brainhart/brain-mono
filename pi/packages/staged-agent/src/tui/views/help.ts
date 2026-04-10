import type { Component } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import { colored, horizontalRule, FG_CYAN, FG_GRAY, BOLD } from "../helpers.js";

export type HelpAction = { type: "close" };

const HELP_CONTENT = [
	["↑ / k", "Move cursor up / scroll up"],
	["↓ / j", "Move cursor down / scroll down"],
	["enter", "Drill into selected item"],
	["esc / backspace", "Go back to parent view"],
	["", ""],
	["p", "Pause job (dashboard)"],
	["r", "Resume paused job (dashboard)"],
	["c", "Cancel entire job (dashboard)"],
	["x", "Cancel single task (task view)"],
	["l", "Toggle event log"],
	["g", "Jump to latest (event log)"],
	["", ""],
	["?", "Toggle this help overlay"],
	["q", "Quit TUI (job continues in background)"],
] as const;

export class HelpView implements Component {
	onAction: ((action: HelpAction) => void) | undefined;

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "?") || matchesKey(data, "q")) {
			this.onAction?.({ type: "close" });
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(horizontalRule(width));
		lines.push(colored("  Keybindings", BOLD, FG_CYAN));
		lines.push(horizontalRule(width));
		lines.push("");
		for (const [key, desc] of HELP_CONTENT) {
			if (!key) { lines.push(""); continue; }
			const keyStr = colored(key.padEnd(20), FG_CYAN);
			lines.push(`  ${keyStr}${desc}`);
		}
		lines.push("");
		lines.push(horizontalRule(width));
		lines.push(colored("  Press ? or esc to close", FG_GRAY));
		return lines;
	}
}
