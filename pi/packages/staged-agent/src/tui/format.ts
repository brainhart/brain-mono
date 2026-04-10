import { stripAnsi } from "./ansi.js";

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

export function truncate(text: string, maxLen: number): string {
	const plain = stripAnsi(text);
	if (plain.length <= maxLen) return text;
	return plain.slice(0, maxLen - 1) + "…";
}

export function padRight(text: string, width: number): string {
	const plain = stripAnsi(text);
	const diff = width - plain.length;
	return diff > 0 ? text + " ".repeat(diff) : text;
}

export function padLeft(text: string, width: number): string {
	const plain = stripAnsi(text);
	const diff = width - plain.length;
	return diff > 0 ? " ".repeat(diff) + text : text;
}

export function horizontalRule(width: number, char = "─"): string {
	return char.repeat(width);
}

export function centerText(text: string, width: number): string {
	const plain = stripAnsi(text);
	const pad = Math.max(0, Math.floor((width - plain.length) / 2));
	return " ".repeat(pad) + text;
}

export function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const rawLine of text.split("\n")) {
		if (rawLine.length <= width) {
			lines.push(rawLine);
			continue;
		}
		let remaining = rawLine;
		while (remaining.length > width) {
			let breakAt = remaining.lastIndexOf(" ", width);
			if (breakAt <= 0) breakAt = width;
			lines.push(remaining.slice(0, breakAt));
			remaining = remaining.slice(breakAt).trimStart();
		}
		if (remaining) lines.push(remaining);
	}
	return lines;
}
