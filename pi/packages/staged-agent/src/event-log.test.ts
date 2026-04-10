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

	it("assigns monotonic seq numbers", () => {
		const log = new EventLog();
		log.append(sampleEvent);
		log.append({ type: "job_completed", jobId: "j1", timestamp: 2 });
		const events = log.getEvents();
		assert.equal((events[0] as Record<string, unknown>).seq, 1);
		assert.equal((events[1] as Record<string, unknown>).seq, 2);
		log.close();
	});

	it("throws on append after close", () => {
		const log = new EventLog();
		log.close();
		assert.throws(() => log.append(sampleEvent), /closed/);
		assert.equal(log.isClosed, true);
	});

	it("supports fsync option", () => {
		const tmpFile = path.join(
			os.tmpdir(),
			`staged-agent-fsync-${Date.now()}.ndjson`,
		);
		tmpFiles.push(tmpFile);

		const log = new EventLog(tmpFile, { fsync: true });
		log.append(sampleEvent);
		log.close();

		const replayed = EventLog.replay(tmpFile);
		assert.equal(replayed.length, 1);
	});

	it("skips corrupt lines during replay", () => {
		const tmpFile = path.join(
			os.tmpdir(),
			`staged-agent-corrupt-${Date.now()}.ndjson`,
		);
		tmpFiles.push(tmpFile);

		const good = JSON.stringify(sampleEvent);
		fs.writeFileSync(tmpFile, `${good}\n{corrupt\n${good}\n`);

		const result = EventLog.replayWithDiagnostics(tmpFile);
		assert.equal(result.events.length, 2);
		assert.deepEqual(result.corruptLines, [2]);
	});

	it("handles trailing corrupt line (crash mid-write)", () => {
		const tmpFile = path.join(
			os.tmpdir(),
			`staged-agent-trailing-${Date.now()}.ndjson`,
		);
		tmpFiles.push(tmpFile);

		const good = JSON.stringify(sampleEvent);
		fs.writeFileSync(tmpFile, `${good}\n{"type":"job_com`);

		const result = EventLog.replayWithDiagnostics(tmpFile);
		assert.equal(result.events.length, 1);
		assert.deepEqual(result.corruptLines, [2]);
	});

	it("seq numbers survive replay", () => {
		const tmpFile = path.join(
			os.tmpdir(),
			`staged-agent-seq-${Date.now()}.ndjson`,
		);
		tmpFiles.push(tmpFile);

		const log = new EventLog(tmpFile);
		log.append(sampleEvent);
		log.append({ type: "job_completed", jobId: "j1", timestamp: 2 });
		log.close();

		const replayed = EventLog.replay(tmpFile);
		assert.equal((replayed[0] as Record<string, unknown>).seq, 1);
		assert.equal((replayed[1] as Record<string, unknown>).seq, 2);
	});
});
