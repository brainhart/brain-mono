import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeEvent } from "./events.js";

export type EventLogOpts = {
	fsync?: boolean;
};

export type ReplayResult = {
	events: RuntimeEvent[];
	corruptLines: number[];
};

/**
 * Append-only NDJSON event log.
 *
 * When `filePath` is provided events are persisted to disk.
 * In-memory mode (no path) is useful for testing.
 */
export class EventLog {
	private readonly entries: RuntimeEvent[] = [];
	private readonly filePath: string | undefined;
	private readonly fsyncEnabled: boolean;
	private fd: number | undefined;
	private closed = false;
	private nextSeq = 1;

	constructor(filePath?: string, opts?: EventLogOpts) {
		this.filePath = filePath;
		this.fsyncEnabled = opts?.fsync ?? false;
		if (filePath) {
			const dir = path.dirname(filePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			this.fd = fs.openSync(filePath, "a");
		}
	}

	append(event: RuntimeEvent): void {
		if (this.closed) {
			throw new Error("EventLog is closed");
		}
		const stamped = { ...event, seq: this.nextSeq++ };
		this.entries.push(stamped as RuntimeEvent);
		if (this.fd !== undefined) {
			fs.writeSync(this.fd, JSON.stringify(stamped) + "\n");
			if (this.fsyncEnabled) {
				fs.fdatasyncSync(this.fd);
			}
		}
	}

	getEvents(): readonly RuntimeEvent[] {
		return this.entries;
	}

	close(): void {
		if (this.fd !== undefined) {
			fs.closeSync(this.fd);
			this.fd = undefined;
		}
		this.closed = true;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/**
	 * Replay events from a persisted NDJSON log file.
	 *
	 * Corrupt lines (e.g. from a crash mid-write) are skipped.
	 * Use `replayWithDiagnostics` to also get the corrupt line numbers.
	 */
	static replay(filePath: string): RuntimeEvent[] {
		return EventLog.replayWithDiagnostics(filePath).events;
	}

	static replayWithDiagnostics(filePath: string): ReplayResult {
		if (!fs.existsSync(filePath)) return { events: [], corruptLines: [] };
		const content = fs.readFileSync(filePath, "utf-8").trim();
		if (!content) return { events: [], corruptLines: [] };

		const lines = content.split("\n");
		const events: RuntimeEvent[] = [];
		const corruptLines: number[] = [];

		for (let i = 0; i < lines.length; i++) {
			try {
				events.push(JSON.parse(lines[i]) as RuntimeEvent);
			} catch {
				corruptLines.push(i + 1);
			}
		}

		return { events, corruptLines };
	}
}
