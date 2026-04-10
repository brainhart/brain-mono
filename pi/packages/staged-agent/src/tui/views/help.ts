import type { Component } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import { colored, horizontalRule, FG_CYAN, FG_GRAY, FG_WHITE, BOLD, DIM } from "../helpers.js";
import { renderFooter } from "../keybindings.js";

export type HelpAction = { type: "close" } | { type: "quit" };

const SECTIONS: Array<{ title: string; keys: Array<[string, string]> }> = [
	{
		title: "Navigation (vim motions)",
		keys: [
			["j / ↓", "Move down / scroll down"],
			["k / ↑", "Move up / scroll up"],
			["gg", "Jump to top"],
			["G", "Jump to bottom"],
			["Ctrl-d", "Half-page down"],
			["Ctrl-u", "Half-page up"],
		],
	},
	{
		title: "Selection",
		keys: [
			["⏎ / l", "Drill into / select"],
			["h / esc / bksp", "Go back to parent"],
		],
	},
	{
		title: "Job control (dashboard)",
		keys: [
			["p", "Pause job"],
			["r", "Resume paused job"],
			["c", "Cancel entire job"],
		],
	},
	{
		title: "Task actions (task view)",
		keys: [
			["x", "Cancel single running task"],
			["t", "View session transcript"],
		],
	},
	{
		title: "Views",
		keys: [
			["L", "Event log"],
			["d", "DAG visualization"],
			["?", "Close this help"],
			["q", "Quit TUI (job continues)"],
		],
	},
];

export class HelpView implements Component {
	onAction: ((action: HelpAction) => void) | undefined;

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, "q")) {
			this.onAction?.({ type: "quit" });
		} else if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "?")) {
			this.onAction?.({ type: "close" });
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(horizontalRule(width));
		lines.push(colored("  Keybindings", BOLD, FG_WHITE));
		lines.push(horizontalRule(width));

		for (const section of SECTIONS) {
			lines.push("");
			lines.push(colored(`  ${section.title}`, BOLD, FG_CYAN));
			lines.push("");
			for (const [key, desc] of section.keys) {
				lines.push(`    ${colored(key.padEnd(20), FG_CYAN)}${colored(desc, FG_GRAY)}`);
			}
		}

		lines.push("");
		lines.push(horizontalRule(width));
		lines.push(renderFooter([["?/esc", "close"]], { mode: "HELP" }));
		return lines;
	}
}
