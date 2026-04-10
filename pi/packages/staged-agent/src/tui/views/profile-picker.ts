import type { Component } from "@mariozechner/pi-tui";
import {
	colored, horizontalRule, FG_CYAN, FG_GRAY, FG_WHITE, BOLD, DIM,
} from "../helpers.js";
import { clampCursor, parseNavKey, KeyState, renderFooter } from "../keybindings.js";
import type { JobProfile } from "../../profiles.js";

export type ProfilePickerAction =
	| { type: "select"; profile: JobProfile }
	| { type: "cancel" }
	| { type: "quit" };

export class ProfilePickerView implements Component {
	private readonly keyState = new KeyState();
	private cursor = 0;
	onAction: ((action: ProfilePickerAction) => void) | undefined;

	constructor(private readonly profiles: JobProfile[]) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const nav = parseNavKey(data, this.keyState);
		if (nav) {
			switch (nav.type) {
				case "up":
					this.cursor = clampCursor(this.cursor - 1, this.profiles.length);
					return;
				case "down":
					this.cursor = clampCursor(this.cursor + 1, this.profiles.length);
					return;
				case "top":
					this.cursor = 0;
					return;
				case "bottom":
					this.cursor = clampCursor(this.profiles.length - 1, this.profiles.length);
					return;
				case "enter": {
					const profile = this.profiles[this.cursor];
					if (profile) this.onAction?.({ type: "select", profile });
					return;
				}
				case "back":
					this.onAction?.({ type: "cancel" });
					return;
				case "quit":
					this.onAction?.({ type: "quit" });
					return;
				default:
					return;
			}
		}
	}

	render(width: number): string[] {
		const cardWidth = Math.max(48, Math.min(width, 96));
		const lines: string[] = [];

		lines.push(horizontalRule(cardWidth));
		lines.push(colored("  Choose a profile", BOLD, FG_WHITE));
		lines.push(horizontalRule(cardWidth));
		lines.push("");
		lines.push(colored("  How should this task be structured?", FG_GRAY));
		lines.push("");

		for (let i = 0; i < this.profiles.length; i++) {
			const p = this.profiles[i];
			const prefix = i === this.cursor
				? colored(" ▶ ", FG_CYAN, BOLD)
				: "   ";
			lines.push(
				prefix + colored(p.name, FG_CYAN, BOLD),
			);
			lines.push(
				"     " + colored(p.description, FG_GRAY, DIM),
			);
		}

		lines.push("");
		lines.push(horizontalRule(cardWidth));
		lines.push(renderFooter([
			["j/k", "nav"],
			["⏎", "select"],
			["esc", "back"],
			["q", "quit"],
		], { mode: "PROFILE" }));
		return lines;
	}
}
