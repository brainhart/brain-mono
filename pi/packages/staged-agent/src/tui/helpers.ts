/**
 * Shared helpers for staged-agent TUI views.
 * Thin wrappers over pi-tui utilities — no custom ANSI/rendering logic.
 */

import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export { truncateToWidth, visibleWidth };

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const FG_RED = `${ESC}31m`;
const FG_GREEN = `${ESC}32m`;
const FG_YELLOW = `${ESC}33m`;
const FG_CYAN = `${ESC}36m`;
const FG_GRAY = `${ESC}90m`;
const FG_WHITE = `${ESC}97m`;

export function colored(text: string, ...codes: string[]): string {
	if (codes.length === 0) return text;
	return codes.join("") + text + RESET;
}

export const sym = {
	success: "✓",
	failure: "✗",
	running: "⟳",
	waiting: "◌",
	paused: "‖",
	skipped: "–",
	idle: "…",
} as const;

export function statusIcon(status: string): string {
	switch (status) {
		case "completed": case "success":  return colored(sym.success, FG_GREEN);
		case "failed":    case "failure":  return colored(sym.failure, FG_RED);
		case "running":                    return colored(sym.running, FG_CYAN);
		case "waiting":   case "pending":  return colored(sym.waiting, FG_GRAY);
		case "paused":                     return colored(sym.paused, FG_YELLOW);
		case "skipped":                    return colored(sym.skipped, FG_GRAY, DIM);
		case "idle":                       return colored(sym.idle, FG_YELLOW);
		default:                           return colored("?", FG_GRAY);
	}
}

export function statusLabel(status: string): string {
	switch (status) {
		case "completed": return colored("completed", FG_GREEN);
		case "failed":    return colored("failed", FG_RED);
		case "running":   return colored("running", FG_CYAN, BOLD);
		case "waiting":   return colored("waiting", FG_GRAY);
		case "pending":   return colored("pending", FG_GRAY);
		case "paused":    return colored("paused", FG_YELLOW, BOLD);
		case "skipped":   return colored("skipped", FG_GRAY, DIM);
		case "idle":      return colored("idle", FG_YELLOW, BOLD);
		case "success":   return colored("success", FG_GREEN);
		case "failure":   return colored("failure", FG_RED);
		default:          return colored(status, FG_GRAY);
	}
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rs = Math.floor(s % 60);
	if (m < 60) return `${m}m${rs}s`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return `${h}h${rm}m`;
}

export function horizontalRule(width: number, char = "─"): string {
	return char.repeat(width);
}

export function padRight(text: string, width: number): string {
	const w = visibleWidth(text);
	return w < width ? text + " ".repeat(width - w) : text;
}

export { BOLD, DIM, FG_RED, FG_GREEN, FG_YELLOW, FG_CYAN, FG_GRAY, FG_WHITE, RESET };
