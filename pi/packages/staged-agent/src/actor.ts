/**
 * Minimal actor primitive for Node.js single-threaded concurrency.
 *
 * Each actor owns private state and processes messages from a mailbox
 * one at a time. No external code can touch the state — the only way
 * to interact with an actor is to send it a message.
 *
 * The serialisation guarantee comes from `drain()`: it dequeues one
 * message, awaits the (possibly async) handler, then dequeues the next.
 * Two messages arriving on the same tick simply enqueue; they are never
 * processed concurrently.
 */

export type ActorRef<M> = {
	send(msg: M): void;
};

export type ActorStatus = "running" | "stopped";

export type TimerHandle = { id: number };

export abstract class Actor<TMsg> {
	private mailbox: TMsg[] = [];
	private draining = false;
	private _stopped = false;
	private nextTimerId = 1;
	private readonly activeTimers = new Map<number, ReturnType<typeof setTimeout>>();

	get status(): ActorStatus {
		return this._stopped ? "stopped" : "running";
	}

	get stopped(): boolean {
		return this._stopped;
	}

	send(msg: TMsg): void {
		if (this._stopped) return;
		this.mailbox.push(msg);
		if (!this.draining) this.drain();
	}

	/**
	 * Schedule a message to be delivered to this actor's mailbox after
	 * `delayMs` milliseconds. Returns a handle that can be passed to
	 * `cancelDelayed` to prevent delivery.
	 */
	sendDelayed(msg: TMsg, delayMs: number): TimerHandle {
		const id = this.nextTimerId++;
		const timer = setTimeout(() => {
			this.activeTimers.delete(id);
			this.send(msg);
		}, delayMs);
		this.activeTimers.set(id, timer);
		return { id };
	}

	cancelDelayed(handle: TimerHandle): void {
		const timer = this.activeTimers.get(handle.id);
		if (timer) {
			clearTimeout(timer);
			this.activeTimers.delete(handle.id);
		}
	}

	ref(): ActorRef<TMsg> {
		return { send: (msg: TMsg) => this.send(msg) };
	}

	stop(): void {
		this._stopped = true;
		this.mailbox.length = 0;
		for (const [, timer] of this.activeTimers) {
			clearTimeout(timer);
		}
		this.activeTimers.clear();
	}

	protected abstract handle(msg: TMsg): Promise<void> | void;

	private async drain(): Promise<void> {
		this.draining = true;
		while (this.mailbox.length > 0 && !this._stopped) {
			const msg = this.mailbox.shift()!;
			try {
				await this.handle(msg);
			} catch (err) {
				this.onError(err);
			}
		}
		this.draining = false;
	}

	protected onError(err: unknown): void {
		console.error(`[Actor] unhandled error:`, err);
	}
}

/**
 * A Deferred is a Promise whose resolve/reject are externally accessible.
 * Used for request-reply patterns between actors.
 */
export class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T) => void;
	reject!: (reason: unknown) => void;

	constructor() {
		this.promise = new Promise<T>((res, rej) => {
			this.resolve = res;
			this.reject = rej;
		});
	}
}
