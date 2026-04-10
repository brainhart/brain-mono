/**
 * ASCII DAG visualization of the stage dependency graph.
 *
 * Renders a topological layout showing stages as boxes with
 * dependency arrows between them. Each stage shows its status icon.
 */

import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { JobState } from "../../state.js";
import type { JobDefinition, StageId, StageDependency } from "../../types.js";
import {
	colored, statusIcon, horizontalRule, formatDuration,
	FG_CYAN, FG_GRAY, FG_WHITE, FG_YELLOW, BOLD, DIM,
} from "../helpers.js";
import { parseNavKey, KeyState, clampScroll, renderFooter } from "../keybindings.js";

export type DagViewAction =
	| { type: "back" }
	| { type: "help" }
	| { type: "quit" };

type Layer = StageId[];

export class DagView implements Component {
	private state: JobState | undefined;
	private scrollOffset = 0;
	private contentHeight = 0;
	private readonly keyState = new KeyState();
	onAction: ((action: DagViewAction) => void) | undefined;

	constructor(
		private readonly definition: JobDefinition,
	) {}

	setState(state: JobState): void { this.state = state; }
	invalidate(): void {}

	handleInput(data: string): void {
		const nav = parseNavKey(data, this.keyState);
		if (!nav) return;
		switch (nav.type) {
			case "up":   this.scrollOffset = clampScroll(this.scrollOffset - 1, this.contentHeight); return;
			case "down": this.scrollOffset = clampScroll(this.scrollOffset + 1, this.contentHeight); return;
			case "top":  this.scrollOffset = 0; return;
			case "bottom": this.scrollOffset = clampScroll(this.contentHeight, this.contentHeight); return;
			case "half_page_up":   this.scrollOffset = clampScroll(this.scrollOffset - 15, this.contentHeight); return;
			case "half_page_down": this.scrollOffset = clampScroll(this.scrollOffset + 15, this.contentHeight); return;
			case "back":  this.onAction?.({ type: "back" }); return;
			case "help":  this.onAction?.({ type: "help" }); return;
			case "quit":  this.onAction?.({ type: "quit" }); return;
			case "enter": return;
		}
	}

	render(width: number): string[] {
		const state = this.state;
		if (!state) return ["(no state)"];

		const lines: string[] = [];
		lines.push(horizontalRule(width));
		lines.push(colored(" Stage DAG", BOLD, FG_WHITE));
		lines.push(horizontalRule(width));
		lines.push("");

		const layers = this.topologicalLayers();
		const allStageIds = state ? [...state.stages.keys()] : [];
		const dynIds = allStageIds.filter(
			(id) => !this.definition.stages.some((s) => s.id === id),
		);

		const now = Date.now();
		const boxWidth = Math.min(30, Math.floor(width * 0.4));

		for (let li = 0; li < layers.length; li++) {
			const layer = layers[li];
			const stageBoxes = layer.map((sid) => this.renderStageBox(sid, state, boxWidth, now));

			const maxBoxHeight = Math.max(...stageBoxes.map((b) => b.length));
			for (let row = 0; row < maxBoxHeight; row++) {
				let line = "  ";
				for (let si = 0; si < stageBoxes.length; si++) {
					const box = stageBoxes[si];
					line += row < box.length ? box[row] : " ".repeat(boxWidth);
					if (si < stageBoxes.length - 1) line += "  ";
				}
				lines.push(line);
			}

			if (li < layers.length - 1) {
				const arrows = this.renderArrows(layer, layers[li + 1], boxWidth);
				for (const a of arrows) lines.push("  " + a);
			}
		}

		if (dynIds.length > 0) {
			lines.push("");
			lines.push(colored("  Dynamic stages:", FG_YELLOW, BOLD));
			for (const id of dynIds) {
				const ss = state.stages.get(id);
				const icon = statusIcon(ss?.status ?? "waiting");
				lines.push(`    [${icon}] ${id}`);
			}
		}

		lines.push("");
		lines.push(horizontalRule(width));
		lines.push(renderFooter([["j/k", "scroll"], ["gg/G", "top/bot"], ["C-d/u", "page"], ["h/esc", "back"], ["?", "help"], ["q", "quit"]], { mode: "NORMAL" }));

		this.contentHeight = lines.length;
		const maxScroll = Math.max(0, lines.length - 1);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		return this.scrollOffset > 0 ? lines.slice(this.scrollOffset) : lines;
	}

	private renderStageBox(stageId: StageId, state: JobState, boxWidth: number, now: number): string[] {
		const ss = state.stages.get(stageId);
		const status = ss?.status ?? "waiting";
		const icon = statusIcon(status);
		const stageDef = this.definition.stages.find((s) => s.id === stageId);
		const name = stageDef?.name ?? stageId;

		let timeStr = "";
		if (ss?.startedAt) {
			const end = ss.completedAt ?? now;
			timeStr = " " + formatDuration(end - ss.startedAt);
		}

		const innerWidth = boxWidth - 4;
		const topBot = colored("┌" + "─".repeat(boxWidth - 2) + "┐", FG_GRAY, DIM);
		const bottom = colored("└" + "─".repeat(boxWidth - 2) + "┘", FG_GRAY, DIM);

		const nameStr = truncateToWidth(name, innerWidth);
		const namePad = " ".repeat(Math.max(0, innerWidth - visibleWidth(nameStr)));
		const infoStr = truncateToWidth(`${icon} ${status}${timeStr}`, innerWidth);
		const infoPad = " ".repeat(Math.max(0, innerWidth - visibleWidth(infoStr)));

		const line1 = colored("│ ", FG_GRAY, DIM) + colored(nameStr, BOLD, FG_WHITE) + namePad + colored(" │", FG_GRAY, DIM);
		const line2 = colored("│ ", FG_GRAY, DIM) + infoStr + infoPad + colored(" │", FG_GRAY, DIM);

		return [topBot, line1, line2, bottom];
	}

	private renderArrows(fromLayer: StageId[], toLayer: StageId[], boxWidth: number): string[] {
		const arrows: string[] = [];
		const midPositions = new Map<StageId, number>();

		for (let i = 0; i < fromLayer.length; i++) {
			midPositions.set(fromLayer[i], i * (boxWidth + 2) + Math.floor(boxWidth / 2));
		}
		for (let i = 0; i < toLayer.length; i++) {
			midPositions.set(toLayer[i], i * (boxWidth + 2) + Math.floor(boxWidth / 2));
		}

		const connections: Array<{ from: number; to: number }> = [];
		for (const dep of this.definition.dependencies) {
			const fromPos = midPositions.get(dep.parentStageId);
			const toPos = midPositions.get(dep.childStageId);
			if (fromPos !== undefined && toPos !== undefined) {
				connections.push({ from: fromPos, to: toPos });
			}
		}

		if (connections.length === 0) {
			arrows.push(colored("    │", FG_GRAY, DIM));
			arrows.push(colored("    ▼", FG_GRAY, DIM));
			return arrows;
		}

		const maxPos = Math.max(...connections.flatMap((c) => [c.from, c.to]));
		const lineChars = new Array(maxPos + 2).fill(" ");

		for (const conn of connections) {
			lineChars[conn.from] = "│";
		}
		arrows.push(colored(lineChars.join(""), FG_GRAY, DIM));

		const arrowChars = new Array(maxPos + 2).fill(" ");
		for (const conn of connections) {
			arrowChars[conn.to] = "▼";
		}
		arrows.push(colored(arrowChars.join(""), FG_CYAN));

		return arrows;
	}

	private topologicalLayers(): Layer[] {
		const stages = this.definition.stages;
		const deps = this.definition.dependencies;
		const idSet = new Set(stages.map((s) => s.id));
		const inDegree = new Map<StageId, number>();
		const children = new Map<StageId, StageId[]>();

		for (const s of stages) {
			inDegree.set(s.id, 0);
			children.set(s.id, []);
		}

		for (const d of deps) {
			if (idSet.has(d.parentStageId) && idSet.has(d.childStageId)) {
				inDegree.set(d.childStageId, (inDegree.get(d.childStageId) ?? 0) + 1);
				children.get(d.parentStageId)!.push(d.childStageId);
			}
		}

		const layers: Layer[] = [];
		let current = stages.filter((s) => (inDegree.get(s.id) ?? 0) === 0).map((s) => s.id);

		while (current.length > 0) {
			layers.push(current);
			const next: StageId[] = [];
			for (const sid of current) {
				for (const cid of (children.get(sid) ?? [])) {
					const deg = (inDegree.get(cid) ?? 1) - 1;
					inDegree.set(cid, deg);
					if (deg === 0) next.push(cid);
				}
			}
			current = next;
		}

		return layers;
	}

}
