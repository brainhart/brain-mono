import { cursor, screen as scr } from "./ansi.js";

export type KeyEvent =
	| { type: "up" }
	| { type: "down" }
	| { type: "left" }
	| { type: "right" }
	| { type: "enter" }
	| { type: "escape" }
	| { type: "backspace" }
	| { type: "char"; char: string }
	| { type: "ctrl"; char: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "unknown"; raw: Buffer };

export type InputHandler = (key: KeyEvent) => void;

/**
 * Terminal screen manager.
 * Enters alternate buffer + raw mode on start, restores on stop.
 * Dispatches parsed key events to a handler callback.
 */
export class Screen {
	private _cols: number;
	private _rows: number;
	private inputHandler: InputHandler | undefined;
	private rawWasEnabled = false;
	private resizeListener: (() => void) | undefined;
	private dataListener: ((data: Buffer) => void) | undefined;
	private started = false;

	constructor(
		private readonly stdout: NodeJS.WriteStream = process.stdout,
		private readonly stdin: NodeJS.ReadStream = process.stdin,
	) {
		this._cols = stdout.columns ?? 80;
		this._rows = stdout.rows ?? 24;
	}

	get cols(): number { return this._cols; }
	get rows(): number { return this._rows; }

	start(handler: InputHandler): void {
		if (this.started) return;
		this.started = true;
		this.inputHandler = handler;

		this.stdout.write(scr.altEnter + cursor.hide);

		this.rawWasEnabled = this.stdin.isRaw ?? false;
		if (this.stdin.isTTY) {
			this.stdin.setRawMode(true);
		}
		this.stdin.resume();

		this.dataListener = (data: Buffer) => this.parseInput(data);
		this.stdin.on("data", this.dataListener);

		this.resizeListener = () => {
			this._cols = this.stdout.columns ?? 80;
			this._rows = this.stdout.rows ?? 24;
			this.inputHandler?.({ type: "resize", cols: this._cols, rows: this._rows });
		};
		this.stdout.on("resize", this.resizeListener);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;

		if (this.dataListener) {
			this.stdin.removeListener("data", this.dataListener);
			this.dataListener = undefined;
		}
		if (this.resizeListener) {
			this.stdout.removeListener("resize", this.resizeListener);
			this.resizeListener = undefined;
		}

		if (this.stdin.isTTY) {
			this.stdin.setRawMode(this.rawWasEnabled);
		}
		this.stdin.pause();

		this.stdout.write(cursor.show + scr.altExit);
	}

	write(content: string): void {
		this.stdout.write(content);
	}

	clear(): void {
		this.stdout.write(cursor.home + scr.clear);
	}

	private parseInput(data: Buffer): void {
		const s = data.toString();

		if (data[0] === 0x1b && data[1] === 0x5b) {
			switch (data[2]) {
				case 0x41: this.inputHandler?.({ type: "up" }); return;
				case 0x42: this.inputHandler?.({ type: "down" }); return;
				case 0x43: this.inputHandler?.({ type: "right" }); return;
				case 0x44: this.inputHandler?.({ type: "left" }); return;
			}
		}

		if (data[0] === 0x1b) {
			this.inputHandler?.({ type: "escape" });
			return;
		}

		if (data[0] === 0x0d || data[0] === 0x0a) {
			this.inputHandler?.({ type: "enter" });
			return;
		}

		if (data[0] === 0x7f || data[0] === 0x08) {
			this.inputHandler?.({ type: "backspace" });
			return;
		}

		if (data[0] !== undefined && data[0] < 0x20) {
			const char = String.fromCharCode(data[0] + 0x60);
			this.inputHandler?.({ type: "ctrl", char });
			return;
		}

		if (s.length === 1 && s >= " ") {
			this.inputHandler?.({ type: "char", char: s });
			return;
		}

		this.inputHandler?.({ type: "unknown", raw: data });
	}
}
