const ESC = "\x1b[";

export const cursor = {
	hide: `${ESC}?25l`,
	show: `${ESC}?25h`,
	moveTo: (row: number, col: number) => `${ESC}${row};${col}H`,
	home: `${ESC}H`,
} as const;

export const screen = {
	altEnter: `${ESC}?1049h`,
	altExit: `${ESC}?1049l`,
	clear: `${ESC}2J`,
	clearLine: `${ESC}2K`,
} as const;

export const style = {
	reset: `${ESC}0m`,
	bold: `${ESC}1m`,
	dim: `${ESC}2m`,
	italic: `${ESC}3m`,
	underline: `${ESC}4m`,
	inverse: `${ESC}7m`,
} as const;

export const fg = {
	black: `${ESC}30m`,
	red: `${ESC}31m`,
	green: `${ESC}32m`,
	yellow: `${ESC}33m`,
	blue: `${ESC}34m`,
	magenta: `${ESC}35m`,
	cyan: `${ESC}36m`,
	white: `${ESC}37m`,
	gray: `${ESC}90m`,
	brightRed: `${ESC}91m`,
	brightGreen: `${ESC}92m`,
	brightYellow: `${ESC}93m`,
	brightBlue: `${ESC}94m`,
	brightMagenta: `${ESC}95m`,
	brightCyan: `${ESC}96m`,
	brightWhite: `${ESC}97m`,
} as const;

export const bg = {
	black: `${ESC}40m`,
	red: `${ESC}41m`,
	green: `${ESC}42m`,
	yellow: `${ESC}43m`,
	blue: `${ESC}44m`,
	magenta: `${ESC}45m`,
	cyan: `${ESC}46m`,
	white: `${ESC}47m`,
} as const;

export function colored(text: string, ...codes: string[]): string {
	if (codes.length === 0) return text;
	return codes.join("") + text + style.reset;
}

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
