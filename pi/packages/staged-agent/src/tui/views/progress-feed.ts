/**
 * Structured progress rendering matching the pi coding-agent TUI style.
 *
 * Uses pi-tui Box/Text/Markdown to render tool calls with colored
 * backgrounds (pending/success/error), text output with markdown
 * rendering, and status messages with spinners.
 */

import { Box, Container, Spacer, Text, type Component } from "@mariozechner/pi-tui";
import type { TaskProgress } from "../../types.js";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const FG_CYAN = `${ESC}36m`;
const FG_GRAY = `${ESC}90m`;
const FG_WHITE = `${ESC}97m`;
const FG_YELLOW = `${ESC}33m`;
const BG_TOOL = `${ESC}48;5;236m`;
const BG_STATUS = `${ESC}48;5;234m`;

function c(text: string, ...codes: string[]): string {
	return codes.length === 0 ? text : codes.join("") + text + RESET;
}

const toolBg = (text: string) => BG_TOOL + text + RESET;
const statusBg = (text: string) => BG_STATUS + text + RESET;

/**
 * Renders a single TaskProgress entry as a pi-tui Component.
 */
function renderProgressEntry(entry: TaskProgress): Component {
	switch (entry.kind) {
		case "tool_call": {
			const box = new Box(1, 0, toolBg);
			const title = c(entry.toolName ?? "tool", BOLD, FG_CYAN);
			box.addChild(new Text(title, 0, 0));
			if (entry.toolArgs && Object.keys(entry.toolArgs).length > 0) {
				const argsStr = JSON.stringify(entry.toolArgs, null, 2);
				const truncated = argsStr.length > 200
					? argsStr.slice(0, 200) + "…"
					: argsStr;
				box.addChild(new Text(c(truncated, FG_GRAY), 0, 0));
			}
			return box;
		}

		case "tool_result": {
			const box = new Box(1, 0, toolBg);
			const prefix = c("→ ", FG_CYAN, DIM);
			const text = entry.text ?? "(no output)";
			const truncated = text.length > 300 ? text.slice(0, 300) + "…" : text;
			box.addChild(new Text(prefix + c(truncated, FG_GRAY), 0, 0));
			return box;
		}

		case "text": {
			const container = new Container();
			if (entry.text) {
				container.addChild(new Text(entry.text, 1, 0));
			}
			return container;
		}

		case "status": {
			const box = new Box(1, 0, statusBg);
			const spinner = c("⟳ ", FG_YELLOW);
			box.addChild(new Text(spinner + c(entry.text ?? "", FG_WHITE, DIM), 0, 0));
			return box;
		}

		default: {
			const container = new Container();
			container.addChild(new Text(c(`[${entry.kind}] ${entry.text ?? ""}`, FG_GRAY), 1, 0));
			return container;
		}
	}
}

/**
 * Component that renders a feed of TaskProgress entries in the
 * pi coding-agent visual style.
 *
 * Tool calls get Box backgrounds (like ToolExecutionComponent),
 * text gets rendered inline, status messages get dimmed backgrounds.
 */
export class ProgressFeed implements Component {
	private entries: TaskProgress[] = [];
	private maxVisible = 15;

	setEntries(entries: TaskProgress[]): void {
		this.entries = entries;
	}

	setMaxVisible(n: number): void {
		this.maxVisible = n;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.entries.length === 0) return [];

		const container = new Container();
		container.addChild(new Text(c("  Live output:", BOLD, FG_CYAN), 0, 0));
		container.addChild(new Spacer(1));

		const visible = this.entries.slice(-this.maxVisible);
		for (const entry of visible) {
			container.addChild(renderProgressEntry(entry));
		}

		if (this.entries.length > this.maxVisible) {
			container.addChild(
				new Text(c(`  … ${this.entries.length - this.maxVisible} earlier entries`, FG_GRAY, DIM), 0, 0),
			);
		}

		container.addChild(new Spacer(1));
		return container.render(width);
	}
}
