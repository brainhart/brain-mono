import { colored, fg, style, screen as scr } from "../ansi.js";
import { horizontalRule } from "../format.js";
import type { KeyEvent } from "../screen.js";

export type HelpAction = { type: "close" };

const HELP_CONTENT = [
	["↑ / k", "Move cursor up"],
	["↓ / j", "Move cursor down"],
	["enter", "Drill into selected item"],
	["esc / backspace", "Go back to parent view"],
	["p", "Pause job (dashboard only)"],
	["r", "Resume paused job (dashboard only)"],
	["c", "Cancel job (dashboard only)"],
	["?", "Toggle this help overlay"],
	["q", "Quit TUI (job continues in background)"],
] as const;

export class HelpView {
	handleInput(key: KeyEvent): HelpAction | undefined {
		if (
			key.type === "escape" ||
			key.type === "enter" ||
			(key.type === "char" && key.char === "?") ||
			(key.type === "char" && key.char === "q")
		) {
			return { type: "close" };
		}
		return undefined;
	}

	render(cols: number, rows: number): string {
		const lines: string[] = [];

		lines.push(horizontalRule(cols, "─"));
		lines.push(colored("  Keybindings", style.bold, fg.brightCyan));
		lines.push(horizontalRule(cols, "─"));
		lines.push("");

		for (const [key, desc] of HELP_CONTENT) {
			const keyStr = colored(key.padEnd(20), fg.cyan);
			lines.push(`  ${keyStr}${desc}`);
		}

		lines.push("");
		lines.push(horizontalRule(cols, "─"));
		lines.push(colored("  Press ? or esc to close", fg.gray));

		while (lines.length < rows - 1) lines.push("");
		if (lines.length > rows - 1) lines.length = rows - 1;

		return lines.map((l) => scr.clearLine + l).join("\n");
	}
}
