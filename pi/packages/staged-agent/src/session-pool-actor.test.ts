import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Deferred } from "./actor.js";
import { SessionPoolActor } from "./session-pool-actor.js";
import type { SessionId } from "./types.js";

describe("SessionPoolActor", () => {
	it("acquires and releases sessions", async () => {
		const pool = new SessionPoolActor();
		const d = new Deferred<SessionId>();
		pool.send({ type: "acquire", deferred: d });
		const sid = await d.promise;
		assert.ok(sid.startsWith("session-"));
		assert.equal(pool.activeCount, 1);

		pool.send({ type: "release", sessionId: sid });
		await tick();
		assert.equal(pool.activeCount, 0);
	});

	it("queues when at concurrency limit", async () => {
		const pool = new SessionPoolActor(1);

		const d1 = new Deferred<SessionId>();
		pool.send({ type: "acquire", deferred: d1 });
		const sid1 = await d1.promise;

		const d2 = new Deferred<SessionId>();
		pool.send({ type: "acquire", deferred: d2 });
		assert.equal(pool.waitingCount, 1);

		pool.send({ type: "release", sessionId: sid1 });
		const sid2 = await d2.promise;
		assert.ok(sid2.startsWith("session-"));
		assert.equal(pool.waitingCount, 0);
	});

	it("rejects waiters on dispose", async () => {
		const pool = new SessionPoolActor(1);

		const d1 = new Deferred<SessionId>();
		pool.send({ type: "acquire", deferred: d1 });
		await d1.promise;

		const d2 = new Deferred<SessionId>();
		pool.send({ type: "acquire", deferred: d2 });

		pool.send({ type: "dispose" });
		await assert.rejects(d2.promise, /disposed/);
	});
});

function tick(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}
