import { colored, fg, style } from "./ansi.js";

export const sym = {
	success: "✓",
	failure: "✗",
	running: "⟳",
	waiting: "◌",
	paused: "‖",
	skipped: "–",
	arrow: "→",
	bullet: "•",
	ellipsis: "…",
	bar: "─",
} as const;

export function statusIcon(status: string): string {
	switch (status) {
		case "completed":
		case "success":
			return colored(sym.success, fg.green);
		case "failed":
		case "failure":
			return colored(sym.failure, fg.red);
		case "running":
			return colored(sym.running, fg.cyan);
		case "waiting":
		case "pending":
			return colored(sym.waiting, fg.gray);
		case "paused":
			return colored(sym.paused, fg.yellow);
		case "skipped":
			return colored(sym.skipped, fg.gray);
		default:
			return colored("?", fg.gray);
	}
}

export function statusLabel(status: string): string {
	switch (status) {
		case "completed":
			return colored("completed", fg.green);
		case "failed":
			return colored("failed", fg.red);
		case "running":
			return colored("running", fg.cyan, style.bold);
		case "waiting":
			return colored("waiting", fg.gray);
		case "pending":
			return colored("pending", fg.gray);
		case "paused":
			return colored("paused", fg.yellow, style.bold);
		case "skipped":
			return colored("skipped", fg.gray, style.dim);
		case "success":
			return colored("success", fg.green);
		case "failure":
			return colored("failure", fg.red);
		default:
			return colored(status, fg.gray);
	}
}
