/**
 * Shared vim/k9s-style keybinding vocabulary for all TUI views.
 *
 * Every view operates in "normal mode" by default — single keypresses
 * trigger actions immediately, no insert mode. Navigation mirrors
 * neovim and k9s conventions.
 */

import { matchesKey } from "@mariozechner/pi-tui";

export type NavAction =
	| { type: "up" }
	| { type: "down" }
	| { type: "top" }
	| { type: "bottom" }
	| { type: "half_page_up" }
	| { type: "half_page_down" }
	| { type: "enter" }
	| { type: "back" }
	| { type: "help" }
	| { type: "quit" }
	| undefined;

let pendingG = false;

/**
 * Parse a keypress into a standard navigation action.
 * Handles vim motions (j/k, gg/G, Ctrl-d/u, h/l) and
 * k9s conventions (enter/esc, q).
 *
 * Returns undefined for keys that aren't part of the shared
 * vocabulary — views should handle those themselves.
 */
export function parseNavKey(data: string): NavAction {
	if (pendingG) {
		pendingG = false;
		if (matchesKey(data, "g")) return { type: "top" };
		return undefined;
	}

	if (matchesKey(data, "j") || matchesKey(data, "down")) return { type: "down" };
	if (matchesKey(data, "k") || matchesKey(data, "up")) return { type: "up" };

	if (matchesKey(data, "g")) { pendingG = true; return undefined; }
	if (matchesKey(data, "shift+g")) return { type: "bottom" };

	if (matchesKey(data, "ctrl+d")) return { type: "half_page_down" };
	if (matchesKey(data, "ctrl+u")) return { type: "half_page_up" };

	if (matchesKey(data, "enter") || matchesKey(data, "l")) return { type: "enter" };
	if (matchesKey(data, "escape") || matchesKey(data, "h") || matchesKey(data, "backspace")) return { type: "back" };

	if (matchesKey(data, "?")) return { type: "help" };
	if (matchesKey(data, "q")) return { type: "quit" };

	return undefined;
}

/**
 * Clamp a cursor position to list bounds.
 */
export function clampCursor(cursor: number, listLength: number): number {
	if (listLength <= 0) return 0;
	return Math.max(0, Math.min(listLength - 1, cursor));
}

/**
 * Clamp a scroll offset to content bounds.
 */
export function clampScroll(offset: number, contentLength: number): number {
	return Math.max(0, Math.min(Math.max(0, contentLength - 1), offset));
}

/**
 * Render a vim-style footer bar.
 * Accepts key-description pairs and an optional mode label.
 */
export function renderFooter(
	keys: Array<[key: string, desc: string]>,
	opts?: { mode?: string },
): string {
	const ESC = "\x1b[";
	const RESET = `${ESC}0m`;
	const BOLD = `${ESC}1m`;
	const DIM = `${ESC}2m`;
	const FG_CYAN = `${ESC}36m`;
	const FG_GRAY = `${ESC}90m`;
	const FG_WHITE = `${ESC}97m`;
	const BG_DARK = `${ESC}48;5;235m`;

	const parts: string[] = [];
	if (opts?.mode) {
		parts.push(`${BG_DARK}${BOLD}${FG_WHITE} ${opts.mode} ${RESET}`);
	}
	for (const [key, desc] of keys) {
		parts.push(`${FG_CYAN}${key}${RESET} ${desc}`);
	}
	return ` ${parts.join("  ")}`;
}
