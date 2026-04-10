import type { SessionId, SessionPool } from "./types.js";

/**
 * In-process session pool backed by a simple counter.
 *
 * In a real Pi integration this would wrap `AgentSessionRuntime` to
 * create / resume / dispose Pi sessions and enforce concurrency limits.
 * v0 uses a lightweight stand-in so the scheduler can be tested in isolation.
 */
export class InMemorySessionPool implements SessionPool {
	private nextId = 1;
	private readonly active = new Set<SessionId>();
	private readonly concurrency: number;

	constructor(concurrency = Infinity) {
		this.concurrency = concurrency;
	}

	async acquire(): Promise<SessionId> {
		if (this.active.size >= this.concurrency) {
			throw new Error("Session pool exhausted");
		}
		const id = `session-${this.nextId++}`;
		this.active.add(id);
		return id;
	}

	async release(sessionId: SessionId): Promise<void> {
		this.active.delete(sessionId);
	}

	async dispose(): Promise<void> {
		this.active.clear();
	}

	get activeCount(): number {
		return this.active.size;
	}
}
