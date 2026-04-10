import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog } from "./event-log.js";
import type { RuntimeEvent } from "./events.js";

const sampleEvent: RuntimeEvent = {
	type: "job_submitted",
	jobId: "j1",
	stageIds: ["s1", "s2"],
	timestamp: 1,
};

describe("EventLog", () => {
	const tmpFiles: string[] = [];

	afterEach(() => {
		for (const f of tmpFiles) {
			try { fs.unlinkSync(f); } catch { /* noop */ }
		}
		tmpFiles.length = 0;
	});

	it("works in-memory (no file path)", () => {
		const log = new EventLog();
		log.append(sampleEvent);
		assert.equal(log.getEvents().length, 1);
		assert.equal(log.getEvents()[0].type, "job_submitted");
		log.close();
	});

	it("persists to NDJSON and replays", () => {
		const tmpFile = path.join(
			os.tmpdir(),
			`staged-agent-test-${Date.now()}.ndjson`,
		);
		tmpFiles.push(tmpFile);

		const log = new EventLog(tmpFile);
		log.append(sampleEvent);
		log.append({
			type: "job_completed",
			jobId: "j1",
			timestamp: 2,
		});
		log.close();

		const replayed = EventLog.replay(tmpFile);
		assert.equal(replayed.length, 2);
		assert.equal(replayed[0].type, "job_submitted");
		assert.equal(replayed[1].type, "job_completed");
	});

	it("replay returns empty for missing file", () => {
		const events = EventLog.replay("/tmp/nonexistent-staged-agent.ndjson");
		assert.deepEqual(events, []);
	});
});
