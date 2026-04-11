/**
 * Shared vim/k9s-style keybinding vocabulary for all TUI views.
 *
 * Every view operates in "normal mode" by default — single keypresses
 * trigger actions immediately, no insert mode. Navigation mirrors
 * neovim and k9s conventions.
 */

import { matchesKey } from "@mariozechner/pi-tui";
import { initTheme, rawKeyHint } from "@mariozechner/pi-coding-agent";

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

/**
 * Per-view keyboard state for multi-key sequences (gg).
 * Each view should create its own instance to avoid cross-talk.
 */
export class KeyState {
	pendingG = false;
}

let themeInitialized = false;

function ensureInteractiveTheme(): void {
	if (themeInitialized) return;
	initTheme(undefined, false);
	themeInitialized = true;
}

/**
 * Parse a keypress into a standard navigation action.
 * Handles vim motions (j/k, gg/G, Ctrl-d/u, h/l) and
 * k9s conventions (enter/esc, q).
 *
 * Uses per-view KeyState to track the gg two-key sequence.
 * If the first g is followed by a non-g key, that key is
 * re-processed as a normal nav key (not swallowed).
 */
export function parseNavKey(data: string, state: KeyState): NavAction {
	if (state.pendingG) {
		state.pendingG = false;
		if (matchesKey(data, "g")) return { type: "top" };
		// Not a second g — fall through and parse this key normally
	}

	if (matchesKey(data, "j") || matchesKey(data, "down")) return { type: "down" };
	if (matchesKey(data, "k") || matchesKey(data, "up")) return { type: "up" };

	if (matchesKey(data, "g")) { state.pendingG = true; return undefined; }
	if (matchesKey(data, "shift+g")) return { type: "bottom" };

	if (matchesKey(data, "ctrl+d")) return { type: "half_page_down" };
	if (matchesKey(data, "ctrl+u")) return { type: "half_page_up" };

	if (matchesKey(data, "enter") || matchesKey(data, "l")) return { type: "enter" };
	if (matchesKey(data, "escape") || matchesKey(data, "h") || matchesKey(data, "backspace")) return { type: "back" };

	if (matchesKey(data, "?")) return { type: "help" };
	if (matchesKey(data, "q")) return { type: "quit" };

	return undefined;
}

export function clampCursor(cursor: number, listLength: number): number {
	if (listLength <= 0) return 0;
	return Math.max(0, Math.min(listLength - 1, cursor));
}

export function clampScroll(offset: number, contentLength: number): number {
	return Math.max(0, Math.min(Math.max(0, contentLength - 1), offset));
}

export function renderFooter(
	keys: Array<[key: string, desc: string]>,
	opts?: { mode?: string },
): string {
	ensureInteractiveTheme();
	const parts: string[] = [];
	if (opts?.mode) {
		parts.push(rawKeyHint(opts.mode, ""));
	}
	for (const [key, desc] of keys) {
		parts.push(rawKeyHint(key, desc));
	}
	return ` ${parts.join("  ")}`;
}
