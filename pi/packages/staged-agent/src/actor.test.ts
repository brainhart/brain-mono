import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Actor, Deferred } from "./actor.js";

class Accumulator extends Actor<number> {
	values: number[] = [];
	done: Deferred<number[]> | undefined;
	expectedCount = 0;

	protected handle(msg: number): void {
		this.values.push(msg);
		if (this.done && this.values.length >= this.expectedCount) {
			this.done.resolve(this.values);
		}
	}
}

class AsyncActor extends Actor<{ value: number; delay: number }> {
	order: number[] = [];
	done: Deferred<number[]> | undefined;
	expectedCount = 0;

	protected async handle(msg: { value: number; delay: number }): Promise<void> {
		await new Promise((r) => setTimeout(r, msg.delay));
		this.order.push(msg.value);
		if (this.done && this.order.length >= this.expectedCount) {
			this.done.resolve(this.order);
		}
	}
}

describe("Actor", () => {
	it("processes messages in order", async () => {
		const acc = new Accumulator();
		const done = new Deferred<number[]>();
		acc.done = done;
		acc.expectedCount = 3;

		acc.send(1);
		acc.send(2);
		acc.send(3);

		const result = await done.promise;
		assert.deepEqual(result, [1, 2, 3]);
	});

	it("serialises async handlers — no concurrent processing", async () => {
		const actor = new AsyncActor();
		const done = new Deferred<number[]>();
		actor.done = done;
		actor.expectedCount = 3;

		actor.send({ value: 1, delay: 30 });
		actor.send({ value: 2, delay: 10 });
		actor.send({ value: 3, delay: 0 });

		const order = await done.promise;
		assert.deepEqual(order, [1, 2, 3]);
	});

	it("drops messages after stop", () => {
		const acc = new Accumulator();
		acc.send(1);
		acc.stop();
		acc.send(2);
		assert.deepEqual(acc.values, [1]);
		assert.equal(acc.stopped, true);
		assert.equal(acc.status, "stopped");
	});

	it("ref() returns a typed send handle", async () => {
		const acc = new Accumulator();
		const done = new Deferred<number[]>();
		acc.done = done;
		acc.expectedCount = 2;

		const ref = acc.ref();
		ref.send(10);
		ref.send(20);

		const result = await done.promise;
		assert.deepEqual(result, [10, 20]);
	});
});

describe("Deferred", () => {
	it("resolves externally", async () => {
		const d = new Deferred<string>();
		d.resolve("ok");
		assert.equal(await d.promise, "ok");
	});

	it("rejects externally", async () => {
		const d = new Deferred<string>();
		d.reject(new Error("boom"));
		await assert.rejects(d.promise, /boom/);
	});
});
