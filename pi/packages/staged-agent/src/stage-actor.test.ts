import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred } from "./actor.js";
import { EventLog } from "./event-log.js";
import { StageActor } from "./stage-actor.js";
import type { TaskExecutor } from "./types.js";

describe("StageActor hardening", () => {
	it("clears active attempt state when retry-with-note cancels a running task", async () => {
		const parentMessages: Array<{ type: string }> = [];
		const parentRef = {
			send: (msg: { type: string }) => parentMessages.push(msg),
		};
		const poolRef = {
			send: (msg: { type: string; deferred?: Deferred<string> }) => {
				if (msg.type === "acquire" && msg.deferred) {
					msg.deferred.resolve("session-1");
				}
			},
		};
		const log = new EventLog();

		const executor: TaskExecutor = async () => {
			await new Promise((r) => setTimeout(r, 200));
			return { status: "success", summary: "ok" };
		};

		const actor = new StageActor(
			"s1",
			"s1:attempt:1",
			"j1",
			[{ id: "t1", prompt: "do work" }],
			executor,
			poolRef as never,
			parentRef as never,
			log,
			{ maxTaskAttempts: 3 },
		);

		actor.send({ type: "run" });
		await tick(20);
		const originalAttemptId = (actor as unknown as { slots: Map<string, { activeAttemptId?: string }> }).slots.get("t1")?.activeAttemptId;
		actor.send({ type: "retry_task_with_note", taskId: "t1", note: "retry with more care" });
		await tick(20);

		const slot = (actor as unknown as { slots: Map<string, { activeActor?: unknown; activeAttemptId?: string; attemptCount: number }> }).slots.get("t1");
		assert.ok(slot);
		assert.ok(slot.activeActor);
		assert.equal(slot.attemptCount, 2);
		assert.notEqual(slot.activeAttemptId, originalAttemptId);

		log.close();
		assert.deepEqual(parentMessages, []);
	});
});

function tick(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
