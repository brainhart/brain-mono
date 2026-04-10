import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JobRunner } from "./job-runner.js";
import { projectState } from "./state.js";
import type {
	JobDefinition,
	TaskExecutor,
	StageDefinition,
	TaskResult,
	DAGMutator,
} from "./types.js";

function makeStage(
	id: string,
	taskIds?: string[],
	opts?: Partial<StageDefinition>,
): StageDefinition {
	const tids = taskIds ?? [`${id}-task`];
	return {
		id,
		name: id,
		tasks: tids.map((tid) => ({ id: tid, prompt: `Do ${tid}` })),
		...opts,
	};
}

const successExecutor: TaskExecutor = async () => ({
	status: "success",
	summary: "done",
});

function batchRunner(
	def: JobDefinition,
	executor: TaskExecutor,
	opts?: Partial<import("./job-runner.js").JobRunnerOpts>,
): JobRunner {
	return new JobRunner(def, executor, { interactive: false, ...opts });
}

describe("JobRunner (actor-based)", () => {
	it("runs a single-stage job", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan")],
			dependencies: [],
		};
		const result = await batchRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 1);
		assert.ok(result.stageResults.has("plan"));
	});

	it("runs a linear chain of stages in order", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("plan"),
				makeStage("implement"),
				makeStage("review"),
			],
			dependencies: [
				{ parentStageId: "plan", childStageId: "implement" },
				{ parentStageId: "implement", childStageId: "review" },
			],
		};
		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.deepEqual(order, [
			"plan-task",
			"implement-task",
			"review-task",
		]);
	});

	it("runs parallel stages (fan-out / fan-in)", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("plan"),
				makeStage("impl-a"),
				makeStage("impl-b"),
				makeStage("merge"),
			],
			dependencies: [
				{ parentStageId: "plan", childStageId: "impl-a" },
				{ parentStageId: "plan", childStageId: "impl-b" },
				{ parentStageId: "impl-a", childStageId: "merge" },
				{ parentStageId: "impl-b", childStageId: "merge" },
			],
		};
		const result = await batchRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 4);
	});

	it("reports failure when a stage fails beyond retries", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan"), makeStage("implement")],
			dependencies: [
				{ parentStageId: "plan", childStageId: "implement" },
			],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "implement-task") throw new Error("compile error");
			return { status: "success", summary: "done" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.error);
	});

	it("retries stages with maxStageAttempts", async () => {
		let attemptCount = 0;
		const def: JobDefinition = {
			stages: [
				makeStage("flaky", ["t1"], { maxStageAttempts: 3 }),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			attemptCount++;
			if (attemptCount < 3) throw new Error("transient");
			return { status: "success", summary: "done" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.equal(attemptCount, 3);
	});

	it("retries tasks within a stage", async () => {
		let callCount = 0;
		const def: JobDefinition = {
			stages: [
				makeStage("s1", ["t1"], { maxTaskAttempts: 3 }),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			callCount++;
			if (callCount < 3) throw new Error("flaky");
			return { status: "success", summary: "ok" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.equal(callCount, 3);
	});

	it("supports transition functions for adaptive replanning", async () => {
		const planTransition = (
			_parentResults: TaskResult[],
			dag: DAGMutator,
		) => {
			dag.addStage({
				id: "finalize",
				name: "finalize",
				tasks: [{ id: "finalize-task", prompt: "Wrap up" }],
			});
			dag.addDependency("review", "finalize");
		};

		const def: JobDefinition = {
			stages: [makeStage("plan"), makeStage("review")],
			dependencies: [
				{
					parentStageId: "plan",
					childStageId: "review",
					transition: planTransition,
				},
			],
		};

		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};

		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.ok(result.stageResults.has("finalize"));
		assert.deepEqual(order, [
			"plan-task",
			"review-task",
			"finalize-task",
		]);
	});

	it("emits events and state can be projected from the log", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan")],
			dependencies: [],
		};
		const runner = batchRunner(def, successExecutor);
		await runner.run();
		const events = runner.getEventLog().getEvents();
		assert.ok(events.length > 0);
		const types = events.map((e) => e.type);
		assert.ok(types.includes("job_submitted"));
		assert.ok(types.includes("job_completed"));
		assert.ok(types.includes("stage_submitted"));
		assert.ok(types.includes("stage_completed"));
		assert.ok(types.includes("task_started"));
		assert.ok(types.includes("task_completed"));

		const state = projectState(events);
		assert.equal(state.status, "completed");
		assert.equal(state.stages.get("plan")?.status, "completed");
		assert.equal(state.stageResults.get("plan")?.length, 1);
	});

	it("propagates failure to dependent stages", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("a"),
				makeStage("b"),
				makeStage("c"),
			],
			dependencies: [
				{ parentStageId: "a", childStageId: "b" },
				{ parentStageId: "b", childStageId: "c" },
			],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "a-task") throw new Error("fail");
			return { status: "success", summary: "done" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.error?.includes("a"));
	});

	it("handles multi-task stages with all-policy", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("review", ["r1", "r2", "r3"]),
			],
			dependencies: [],
		};
		let count = 0;
		const executor: TaskExecutor = async () => {
			count++;
			return { status: "success", summary: `review ${count}` };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.equal(count, 3);
		assert.equal(result.stageResults.get("review")?.length, 3);
	});

	it("completes with first_success policy on first passing task", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("race", ["fast", "slow"], {
					completionPolicy: { type: "first_success" },
				}),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "slow") {
				return { status: "failure", summary: "nah" };
			}
			return { status: "success", summary: "winner" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
	});

	it("evaluates quorum policy", async () => {
		let idx = 0;
		const def: JobDefinition = {
			stages: [
				makeStage("votes", ["v1", "v2", "v3"], {
					completionPolicy: { type: "quorum", n: 2 },
				}),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			idx++;
			if (idx <= 2) return { status: "success", summary: "yes" };
			return { status: "failure", summary: "no" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
	});

	it("preserves partial results on failure", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("ok-stage"),
				makeStage("bad-stage"),
			],
			dependencies: [
				{ parentStageId: "ok-stage", childStageId: "bad-stage" },
			],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "bad-stage-task") throw new Error("boom");
			return { status: "success", summary: "ok" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.stageResults.has("ok-stage"));
	});

	it("cancels a running job", async () => {
		const def: JobDefinition = {
			stages: [makeStage("slow")],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			await new Promise((r) => setTimeout(r, 5000));
			return { status: "success", summary: "done" };
		};
		const runner = batchRunner(def, executor);
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));
		runner.cancel();

		const result = await promise;
		assert.equal(result.status, "failed");
		assert.ok(result.error?.includes("cancel"));
	});

	it("handles empty job (zero stages)", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const result = await batchRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
		assert.equal(result.stageResults.size, 0);
	});
});

describe("JobRunner — pause/resume", () => {
	it("pauses when transition calls dag.pause() and resumes on resume()", async () => {
		const pauseTransition = (
			_results: TaskResult[],
			dag: DAGMutator,
		) => {
			dag.pause();
		};

		const def: JobDefinition = {
			stages: [makeStage("s1"), makeStage("s2")],
			dependencies: [
				{
					parentStageId: "s1",
					childStageId: "s2",
					transition: pauseTransition,
				},
			],
		};

		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};
		const runner = batchRunner(def, executor);
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 100));
		assert.equal(runner.getJobStatus(), "paused");
		assert.deepEqual(order, ["s1-task"]);

		runner.resume();
		const result = await promise;
		assert.equal(result.status, "completed");
		assert.deepEqual(order, ["s1-task", "s2-task"]);
	});
});

describe("JobRunner — task collaboration", () => {
	it("logs operator notes and retry guidance for a task", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("impl", ["task-a"], { maxTaskAttempts: 3 }),
			],
			dependencies: [],
		};

		const prompts: string[] = [];
		let callCount = 0;
		const executor: TaskExecutor = async (task) => {
			callCount++;
			prompts.push(task.prompt);
			if (callCount === 1) {
				await new Promise((r) => setTimeout(r, 80));
				throw new Error("interrupted for guidance");
			}
			return { status: "success", summary: "guided success" };
		};

		const runner = batchRunner(def, executor);
		const runPromise = runner.run();

		await new Promise((r) => setTimeout(r, 20));
		runner.addTaskOperatorNote("task-a", "impl", "Check auth edge cases");
		runner.retryTaskWithNote("task-a", "impl", "Use the latest auth edge-case findings");

		const result = await runPromise;
		assert.equal(result.status, "completed");
		assert.equal(callCount, 2);
		assert.ok(prompts[1]?.includes("Operator guidance for this retry:"));
		assert.ok(prompts[1]?.includes("Use the latest auth edge-case findings"));

		const state = projectState(runner.getEventLog().getEvents());
		const task = state.tasks.get("task-a");
		assert.ok(task);
		assert.equal(task?.operatorNotes.length, 2);
		assert.deepEqual(
			task?.operatorNotes.map((note) => note.action),
			["note", "retry"],
		);
	});
});

describe("JobRunner — review loop via resetStage", () => {
	it("re-executes a stage when transition calls dag.resetStage()", async () => {
		let reviewCount = 0;

		const reviewTransition = (
			results: TaskResult[],
			dag: DAGMutator,
		) => {
			const approved = results.every(
				(r) => r.signals?.approved === true,
			);
			if (!approved) {
				dag.resetStage("review");
			}
		};

		const def: JobDefinition = {
			stages: [
				makeStage("implement"),
				makeStage("review"),
				makeStage("finalize"),
			],
			dependencies: [
				{ parentStageId: "implement", childStageId: "review" },
				{
					parentStageId: "review",
					childStageId: "finalize",
					transition: reviewTransition,
				},
			],
		};

		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			if (task.id === "review-task") {
				reviewCount++;
				if (reviewCount < 3) {
					return {
						status: "success",
						summary: "needs changes",
						signals: { approved: false },
					};
				}
				return {
					status: "success",
					summary: "approved",
					signals: { approved: true },
				};
			}
			return { status: "success", summary: "done" };
		};

		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "completed");
		assert.equal(reviewCount, 3);
		assert.ok(result.stageResults.has("finalize"));
		assert.deepEqual(order, [
			"implement-task",
			"review-task",
			"review-task",
			"review-task",
			"finalize-task",
		]);
	});
});

describe("JobRunner — inspection views", () => {
	it("exposes job snapshot via inspect()", async () => {
		const def: JobDefinition = {
			stages: [makeStage("plan"), makeStage("impl")],
			dependencies: [
				{ parentStageId: "plan", childStageId: "impl" },
			],
		};
		const runner = batchRunner(def, successExecutor);
		await runner.run();
		const snapshot = runner.inspect();
		assert.ok(snapshot);
		assert.equal(snapshot.status, "completed");
		assert.equal(snapshot.stages.length, 2);
		assert.ok(
			snapshot.stages.every((s) => s.status === "completed"),
		);
		assert.equal(snapshot.stageResults.size, 2);
	});
});

describe("JobRunner — recovery from event log", () => {
	it("recovers state from a persisted event log", async () => {
		const tmpFile = path.join(
			os.tmpdir(),
			`staged-agent-recovery-${Date.now()}.ndjson`,
		);

		const def: JobDefinition = {
			id: "recover-test",
			stages: [makeStage("s1"), makeStage("s2")],
			dependencies: [
				{ parentStageId: "s1", childStageId: "s2" },
			],
		};

		const result = await batchRunner(def, successExecutor, {
			eventLogPath: tmpFile,
		}).run();
		assert.equal(result.status, "completed");

		const recovered = JobRunner.recover(tmpFile, def, successExecutor);
		assert.equal(recovered.alreadyTerminal, true);
		assert.equal(recovered.state.status, "completed");
		assert.equal(recovered.state.stages.size, 2);
		assert.equal(
			recovered.state.stages.get("s1")?.status,
			"completed",
		);
		assert.ok(recovered.state.stageResults.get("s1")?.length);

		try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
	});

	it("provides a runner for non-terminal jobs", async () => {
		const tmpFile = path.join(
			os.tmpdir(),
			`staged-agent-resume-${Date.now()}.ndjson`,
		);

		const def: JobDefinition = {
			id: "resume-test",
			stages: [makeStage("s1"), makeStage("s2")],
			dependencies: [
				{ parentStageId: "s1", childStageId: "s2" },
			],
		};

		const log = new (await import("./event-log.js")).EventLog(tmpFile);
		log.append({
			type: "job_submitted",
			jobId: "resume-test",
			stageIds: ["s1", "s2"],
			timestamp: 1,
		});
		log.append({
			type: "stage_submitted",
			jobId: "resume-test",
			stageId: "s1",
			timestamp: 2,
		});
		log.append({
			type: "stage_completed",
			jobId: "resume-test",
			stageId: "s1",
			timestamp: 3,
		});
		log.close();

		const recovered = JobRunner.recover(tmpFile, def, successExecutor);
		assert.equal(recovered.alreadyTerminal, false);
		assert.equal(recovered.state.status, "running");
		assert.equal(
			recovered.state.stages.get("s1")?.status,
			"completed",
		);
		assert.equal(
			recovered.state.stages.get("s2")?.status,
			"waiting",
		);

		if (!recovered.alreadyTerminal) {
			assert.ok(recovered.runner);
		}

		try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
	});
});

describe("JobRunner — task execution timeout", () => {
	it("fails a task when the executor exceeds taskTimeoutMs", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("slow", ["t1"], {
					taskTimeoutMs: 50,
					maxTaskAttempts: 1,
				}),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			await new Promise((r) => setTimeout(r, 5000));
			return { status: "success", summary: "too late" };
		};
		const result = await batchRunner(def, executor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.error?.includes("timed out") || result.error?.includes("failed"));
	});

	it("succeeds when executor finishes before timeout", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("fast", ["t1"], { taskTimeoutMs: 5000 }),
			],
			dependencies: [],
		};
		const result = await batchRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
	});
});

describe("JobRunner — acquire timeout", () => {
	it("fails a task when session acquire exceeds acquireTimeoutMs", async () => {
		const def: JobDefinition = {
			stages: [
				makeStage("s1", ["t1", "t2"], {
					acquireTimeoutMs: 50,
					maxTaskAttempts: 1,
				}),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async () => {
			await new Promise((r) => setTimeout(r, 5000));
			return { status: "success", summary: "done" };
		};
		const result = await batchRunner(def, executor, {
			concurrency: 1,
		}).run();
		assert.equal(result.status, "failed");
	});
});

describe("JobRunner — empty stage", () => {
	it("completes a stage with zero tasks", async () => {
		const def: JobDefinition = {
			stages: [
				{ id: "empty", name: "empty", tasks: [] },
				makeStage("after"),
			],
			dependencies: [
				{ parentStageId: "empty", childStageId: "after" },
			],
		};
		const result = await batchRunner(def, successExecutor).run();
		assert.equal(result.status, "completed");
		assert.ok(result.stageResults.has("after"));
	});
});

describe("JobRunner — transition throws", () => {
	it("fails the job when a transition function throws", async () => {
		const def: JobDefinition = {
			stages: [makeStage("s1"), makeStage("s2")],
			dependencies: [
				{
					parentStageId: "s1",
					childStageId: "s2",
					transition: () => {
						throw new Error("transition boom");
					},
				},
			],
		};
		const result = await batchRunner(def, successExecutor).run();
		assert.equal(result.status, "failed");
		assert.ok(result.error?.includes("transition boom"));
	});
});

describe("JobRunner — AbortSignal", () => {
	it("passes AbortSignal to executor", async () => {
		let receivedSignal: AbortSignal | undefined;
		const def: JobDefinition = {
			stages: [makeStage("s1")],
			dependencies: [],
		};
		const executor: TaskExecutor = async (_task, _sid, signal) => {
			receivedSignal = signal;
			return { status: "success", summary: "done" };
		};
		await batchRunner(def, executor).run();
		assert.ok(receivedSignal);
		assert.equal(receivedSignal!.aborted, false);
	});

	it("aborts the signal on task timeout", async () => {
		let receivedSignal: AbortSignal | undefined;
		const def: JobDefinition = {
			stages: [
				makeStage("s1", ["t1"], {
					taskTimeoutMs: 50,
					maxTaskAttempts: 1,
				}),
			],
			dependencies: [],
		};
		const executor: TaskExecutor = async (_task, _sid, signal) => {
			receivedSignal = signal;
			await new Promise((r) => setTimeout(r, 5000));
			return { status: "success", summary: "too late" };
		};
		await batchRunner(def, executor).run();
		assert.ok(receivedSignal);
		assert.equal(receivedSignal!.aborted, true);
	});
});

describe("JobRunner — stageResults reset on review loop", () => {
	it("stageResults reflects only the latest attempt after reset", async () => {
		let reviewRound = 0;

		const reviewTransition = (
			results: TaskResult[],
			dag: DAGMutator,
		) => {
			const approved = results.every(
				(r) => r.signals?.approved === true,
			);
			if (!approved) dag.resetStage("review");
		};

		const def: JobDefinition = {
			stages: [
				makeStage("impl"),
				makeStage("review"),
				makeStage("done"),
			],
			dependencies: [
				{ parentStageId: "impl", childStageId: "review" },
				{
					parentStageId: "review",
					childStageId: "done",
					transition: reviewTransition,
				},
			],
		};

		const executor: TaskExecutor = async (task) => {
			if (task.id === "review-task") {
				reviewRound++;
				return {
					status: "success",
					summary: `round ${reviewRound}`,
					signals: { approved: reviewRound >= 2 },
				};
			}
			return { status: "success", summary: "ok" };
		};

		const runner = batchRunner(def, executor);
		await runner.run();

		const events = runner.getEventLog().getEvents();
		const state = projectState(events);
		const reviewResults = state.stageResults.get("review");
		assert.ok(reviewResults);
		assert.equal(reviewResults.length, 1);
		assert.equal(reviewResults[0].summary, "round 2");
	});
});

describe("JobRunner — interactive mode", () => {
	it("starts idle with no stages and stays alive", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const runner = new JobRunner(def, successExecutor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));
		assert.equal(runner.getJobStatus(), "idle");

		runner.finish();
		const result = await promise;
		assert.equal(result.status, "completed");
	});

	it("accepts dynamically submitted stages and runs them", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};

		const runner = new JobRunner(def, executor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));
		assert.equal(runner.getJobStatus(), "idle");

		runner.submit([makeStage("task-1")]);

		await new Promise((r) => setTimeout(r, 100));

		runner.submit([makeStage("task-2")]);

		await new Promise((r) => setTimeout(r, 100));

		runner.finish();
		const result = await promise;

		assert.equal(result.status, "completed");
		assert.ok(order.includes("task-1-task"));
		assert.ok(order.includes("task-2-task"));
		assert.ok(result.stageResults.has("task-1"));
		assert.ok(result.stageResults.has("task-2"));
	});

	it("supports dependencies between dynamically submitted stages", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};

		const runner = new JobRunner(def, executor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));

		runner.submit(
			[makeStage("plan"), makeStage("impl")],
			[{ parentStageId: "plan", childStageId: "impl" }],
		);

		await new Promise((r) => setTimeout(r, 200));

		runner.finish();
		const result = await promise;

		assert.equal(result.status, "completed");
		assert.deepEqual(order, ["plan-task", "impl-task"]);
	});

	it("returns to idle between submissions", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const runner = new JobRunner(def, successExecutor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));
		assert.equal(runner.getJobStatus(), "idle");

		runner.submit([makeStage("s1")]);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(runner.getJobStatus(), "idle");

		runner.submit([makeStage("s2")]);
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(runner.getJobStatus(), "idle");

		runner.finish();
		const result = await promise;
		assert.equal(result.status, "completed");
		assert.ok(result.stageResults.has("s1"));
		assert.ok(result.stageResults.has("s2"));
	});

	it("emits stages_added and job_idle events", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const runner = new JobRunner(def, successExecutor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));
		runner.submit([makeStage("s1")]);
		await new Promise((r) => setTimeout(r, 100));
		runner.finish();

		await promise;

		const events = runner.getEventLog().getEvents();
		const types = events.map((e) => e.type);
		assert.ok(types.includes("job_idle"));
		assert.ok(types.includes("stages_added"));
		assert.ok(types.includes("job_finished"));
		assert.ok(types.includes("job_completed"));
	});

	it("can mix pre-seeded stages with dynamic submissions", async () => {
		const def: JobDefinition = {
			stages: [makeStage("initial")],
			dependencies: [],
		};
		const order: string[] = [];
		const executor: TaskExecutor = async (task) => {
			order.push(task.id);
			return { status: "success", summary: "done" };
		};

		const runner = new JobRunner(def, executor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 100));

		runner.submit([makeStage("followup")]);
		await new Promise((r) => setTimeout(r, 100));

		runner.finish();
		const result = await promise;

		assert.equal(result.status, "completed");
		assert.ok(order.includes("initial-task"));
		assert.ok(order.includes("followup-task"));
	});

	it("stays alive when stages fail in interactive mode", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const executor: TaskExecutor = async (task) => {
			if (task.id === "bad-task") throw new Error("exploded");
			return { status: "success", summary: "done" };
		};

		const runner = new JobRunner(def, executor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));

		runner.submit([makeStage("bad", ["bad-task"])]);
		await new Promise((r) => setTimeout(r, 200));

		assert.equal(runner.getJobStatus(), "idle");

		runner.submit([makeStage("good")]);
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(runner.getJobStatus(), "idle");

		runner.finish();
		const result = await promise;
		assert.equal(result.status, "failed");
		assert.ok(result.stageResults.has("good"));
	});

	it("projectState handles new event types correctly", async () => {
		const def: JobDefinition = {
			stages: [],
			dependencies: [],
		};
		const runner = new JobRunner(def, successExecutor, { interactive: true });
		const promise = runner.run();

		await new Promise((r) => setTimeout(r, 50));
		runner.submit([makeStage("s1")]);
		await new Promise((r) => setTimeout(r, 100));
		runner.finish();
		await promise;

		const state = projectState(runner.getEventLog().getEvents());
		assert.equal(state.status, "completed");
		assert.ok(state.stages.has("s1"));
		assert.equal(state.stages.get("s1")?.status, "completed");
	});
});
