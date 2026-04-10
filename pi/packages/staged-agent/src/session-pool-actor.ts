import { Actor, Deferred } from "./actor.js";
import type { SessionId } from "./types.js";

export type SessionPoolMsg =
	| { type: "acquire"; deferred: Deferred<SessionId> }
	| { type: "release"; sessionId: SessionId }
	| { type: "dispose" };

/**
 * Actor that manages a pool of session slots with natural back-pressure.
 *
 * When all slots are occupied, acquire requests queue in the mailbox
 * until a release message frees a slot.
 */
export class SessionPoolActor extends Actor<SessionPoolMsg> {
	private nextId = 1;
	private readonly active = new Set<SessionId>();
	private readonly waiters: Deferred<SessionId>[] = [];
	private readonly concurrency: number;

	constructor(concurrency = Infinity) {
		super();
		this.concurrency = concurrency;
	}

	protected handle(msg: SessionPoolMsg): void {
		switch (msg.type) {
			case "acquire":
				if (this.active.size < this.concurrency) {
					const id = this.mint();
					this.active.add(id);
					msg.deferred.resolve(id);
				} else {
					this.waiters.push(msg.deferred);
				}
				break;

			case "release":
				this.active.delete(msg.sessionId);
				if (this.waiters.length > 0) {
					const waiter = this.waiters.shift()!;
					const id = this.mint();
					this.active.add(id);
					waiter.resolve(id);
				}
				break;

			case "dispose":
				this.active.clear();
				for (const w of this.waiters) {
					w.reject(new Error("Session pool disposed"));
				}
				this.waiters.length = 0;
				this.stop();
				break;
		}
	}

	private mint(): SessionId {
		return `session-${this.nextId++}`;
	}

	get activeCount(): number {
		return this.active.size;
	}

	get waitingCount(): number {
		return this.waiters.length;
	}
}
