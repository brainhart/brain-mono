/**
 * Transcript viewer for a completed or running task's Pi session.
 *
 * Loads the session file via SessionManager.open() and renders the
 * conversation entries (user messages, assistant messages, tool calls,
 * tool results) in a scrollable view.
 */

import type { Component } from "@mariozechner/pi-tui";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
	colored, horizontalRule,
	FG_CYAN, FG_GRAY, FG_GREEN, FG_RED, FG_YELLOW, FG_WHITE, BOLD, DIM,
} from "../helpers.js";
import { parseNavKey, clampScroll, renderFooter } from "../keybindings.js";

export type TranscriptEntry = {
	role: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "other";
	text: string;
};

export type TranscriptViewAction =
	| { type: "back" }
	| { type: "help" }
	| { type: "quit" };

/**
 * Parse raw session entries into displayable transcript entries.
 * Session entries come from SessionManager.getEntries() and have
 * a `type` field and a `message` field with `role` and `content`.
 */
export function parseTranscript(entries: unknown[]): TranscriptEntry[] {
	const result: TranscriptEntry[] = [];

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;

		if (e.type === "message" && e.message && typeof e.message === "object") {
			const msg = e.message as Record<string, unknown>;
			const role = String(msg.role ?? "other");
			const content = msg.content;
			let text = "";

			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				const parts: string[] = [];
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as Record<string, unknown>;
					if (p.type === "text" && typeof p.text === "string") {
						parts.push(p.text);
					} else if (p.type === "thinking" && typeof p.thinking === "string") {
						parts.push(`[thinking] ${p.thinking}`);
					} else if (p.type === "toolCall" && typeof p.name === "string") {
						const args = p.arguments ? JSON.stringify(p.arguments) : "";
						const truncArgs = args.length > 200 ? args.slice(0, 200) + "…" : args;
						parts.push(`⚡ ${p.name}(${truncArgs})`);
					} else if (p.type === "toolResult") {
						const resultContent = p.content;
						if (Array.isArray(resultContent)) {
							for (const rc of resultContent) {
								if (rc && typeof rc === "object" && (rc as Record<string, unknown>).type === "text") {
									const t = String((rc as Record<string, unknown>).text ?? "");
									parts.push(`→ ${t.length > 300 ? t.slice(0, 300) + "…" : t}`);
								}
							}
						}
					}
				}
				text = parts.join("\n");
			}

			if (text.trim()) {
				const mappedRole = role === "user" ? "user"
					: role === "assistant" ? "assistant"
					: role === "system" ? "system"
					: "other";
				result.push({ role: mappedRole, text: text.trim() });
			}
		}
	}

	return result;
}

export class TranscriptView implements Component {
	private entries: TranscriptEntry[] = [];
	private scrollOffset = 0;
	private contentHeight = 0;
	private taskId: string;
	private sessionId: string;
	private loading = false;
	private error: string | undefined;
	onAction: ((action: TranscriptViewAction) => void) | undefined;

	constructor(taskId: string, sessionId: string) {
		this.taskId = taskId;
		this.sessionId = sessionId;
	}

	setEntries(entries: TranscriptEntry[]): void {
		this.entries = entries;
		this.loading = false;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
	}

	setError(error: string): void {
		this.error = error;
		this.loading = false;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const nav = parseNavKey(data);
		if (!nav) return;
		switch (nav.type) {
			case "up":   this.scrollOffset = clampScroll(this.scrollOffset - 3, this.contentHeight); return;
			case "down": this.scrollOffset = clampScroll(this.scrollOffset + 3, this.contentHeight); return;
			case "top":  this.scrollOffset = 0; return;
			case "bottom": this.scrollOffset = clampScroll(this.contentHeight, this.contentHeight); return;
			case "half_page_up":   this.scrollOffset = clampScroll(this.scrollOffset - 20, this.contentHeight); return;
			case "half_page_down": this.scrollOffset = clampScroll(this.scrollOffset + 20, this.contentHeight); return;
			case "back":  this.onAction?.({ type: "back" }); return;
			case "help":  this.onAction?.({ type: "help" }); return;
			case "quit":  this.onAction?.({ type: "quit" }); return;
			case "enter": return;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];

		lines.push(colored(` Transcript: ${this.taskId}`, FG_GRAY, DIM));
		lines.push(horizontalRule(width));
		lines.push(
			colored(" Session transcript", BOLD, FG_WHITE)
			+ colored(`  ${this.sessionId}`, FG_GRAY, DIM),
		);
		lines.push(horizontalRule(width));
		lines.push("");

		if (this.loading) {
			lines.push(colored("  Loading transcript…", FG_CYAN));
			lines.push("");
		} else if (this.error) {
			lines.push(colored(`  Error: ${this.error}`, FG_RED));
			lines.push("");
		} else if (this.entries.length === 0) {
			lines.push(colored("  No transcript entries found", FG_GRAY));
			lines.push("");
		} else {
			for (const entry of this.entries) {
				lines.push(...this.renderEntry(entry, width));
			}
		}

		lines.push(horizontalRule(width));
		lines.push(renderFooter([["j/k", "scroll"], ["gg/G", "top/bot"], ["C-d/u", "page"], ["h/esc", "back"], ["?", "help"], ["q", "quit"]], { mode: "NORMAL" }));

		this.contentHeight = lines.length;
		const maxScroll = Math.max(0, lines.length - 1);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		return this.scrollOffset > 0 ? lines.slice(this.scrollOffset) : lines;
	}

	private renderEntry(entry: TranscriptEntry, width: number): string[] {
		const lines: string[] = [];
		let roleLabel: string;
		let roleColor: string;

		switch (entry.role) {
			case "user":
				roleLabel = "User";
				roleColor = FG_GREEN;
				break;
			case "assistant":
				roleLabel = "Assistant";
				roleColor = FG_CYAN;
				break;
			case "system":
				roleLabel = "System";
				roleColor = FG_YELLOW;
				break;
			default:
				roleLabel = entry.role;
				roleColor = FG_GRAY;
				break;
		}

		lines.push(colored(`  ${roleLabel}:`, BOLD, roleColor));
		const wrapped = wrapTextWithAnsi(entry.text, Math.max(1, width - 4));
		for (const wl of wrapped) {
			lines.push("    " + wl);
		}
		lines.push("");

		return lines;
	}

}
