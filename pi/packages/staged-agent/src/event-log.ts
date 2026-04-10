import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeEvent } from "./events.js";

/**
 * Append-only NDJSON event log.
 *
 * When `filePath` is provided events are persisted to disk.
 * In-memory mode (no path) is useful for testing.
 */
export class EventLog {
	private readonly entries: RuntimeEvent[] = [];
	private readonly filePath: string | undefined;
	private fd: number | undefined;

	constructor(filePath?: string) {
		this.filePath = filePath;
		if (filePath) {
			const dir = path.dirname(filePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			this.fd = fs.openSync(filePath, "a");
		}
	}

	append(event: RuntimeEvent): void {
		this.entries.push(event);
		if (this.fd !== undefined) {
			fs.writeSync(this.fd, JSON.stringify(event) + "\n");
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
	}

	static replay(filePath: string): RuntimeEvent[] {
		if (!fs.existsSync(filePath)) return [];
		const content = fs.readFileSync(filePath, "utf-8").trim();
		if (!content) return [];
		return content.split("\n").map((line) => JSON.parse(line) as RuntimeEvent);
	}
}
