import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BotService } from "../src/bots/service";
import type { BotEvent, Cursor } from "../src/bots/types";

interface Frame {
	kind: string;
	cursor: Cursor;
	capabilities?: string[];
	jobs?: Array<{ job_id: string }>;
	type?: string;
	job_id?: string;
}

test("a paged watch commits one snapshot watermark then replays admission during bootstrap without a gap", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-observation-"));
	let workerStarts = 0;
	const service = new BotService(root, {
		ensure_worker: async () => {
			workerStarts++;
		},
	});
	const abort = new AbortController();
	try {
		await service.create({ bot_name: "reviewer", cwd: root });
		const existing = new Set<string>();
		for (let i = 0; i < 101; i++) {
			const receipt = await service.submit("reviewer", { command: "submit", input: `Assignment ${i}` });
			existing.add(receipt.job_id!);
		}
		const startsBeforeObservation = workerStarts;
		const watch = service.watch("reviewer", { signal: abort.signal })[Symbol.asyncIterator]();
		const begin = (await watch.next()).value as Frame;
		expect(begin.kind).toBe("snapshot.begin");
		expect(begin.capabilities).toEqual(
			expect.arrayContaining([
				"bot.questions.v1",
				"bot.ownership.v1",
				"bot.identity-guard.v1",
				"bot.scoped-refs.v1",
			]),
		);
		const late = await service.submit("reviewer", { command: "submit", input: "Arrived during bootstrap" });
		const snapshotJobs: string[] = [];
		for (;;) {
			const frame = (await watch.next()).value as Frame;
			expect(frame.cursor).toEqual(begin.cursor);
			expect(frame.capabilities).toEqual(begin.capabilities);
			if (frame.kind === "snapshot.end") break;
			expect(frame.kind).toBe("snapshot.page");
			snapshotJobs.push(...frame.jobs!.map(job => job.job_id));
		}
		expect(new Set(snapshotJobs)).toEqual(existing);
		expect(snapshotJobs).not.toContain(late.job_id!);
		let changed: BotEvent | undefined;
		for (let i = 0; i < 10 && !changed; i++) {
			const event = (await watch.next()).value as BotEvent;
			expect(BigInt(event.cursor.seq)).toBeGreaterThan(BigInt(begin.cursor.seq));
			if (event.type === "job.changed" && event.job_id === late.job_id) changed = event;
		}
		expect(changed?.data).toMatchObject({ job: { job_id: late.job_id, pending_input_count: 1 } });
		expect(workerStarts).toBe(startsBeforeObservation + 1);
		abort.abort();
		await watch.return?.();
		expect(service.status("reviewer", late.job_id!).jobs[0]!.state).toBe("queued");
	} finally {
		abort.abort();
		await service.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("job-scoped observation publishes idle-worker loss once and retains whole-Bot counts", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-connectivity-"));
	const service = new BotService(root, { ensure_worker: async () => {} });
	const abort = new AbortController();
	let clock: { mockRestore(): void } | undefined;
	const worker = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], {
		stdin: "pipe",
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		const bot = await service.create({ bot_name: "reviewer", cwd: root });
		const first = service.store.admit(bot.bot_id, { command: "submit", input: "First" });
		service.store.admit(bot.bot_id, { command: "submit", input: "Second" });
		service.store.claimWorker(bot.bot_id, "fixture-owner", worker.pid);
		const watch = service.watch("reviewer", { job_id: first.job_id!, signal: abort.signal })[Symbol.asyncIterator]();
		const snapshot = (await watch.next()).value;
		expect(snapshot).toMatchObject({ kind: "snapshot", bot: { jobs_total: 2, worker: { state: "online" } } });
		worker.kill("SIGKILL");
		await worker.exited;
		clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
		const event = (await watch.next()).value;
		expect(event).toMatchObject({
			type: "bot.changed",
			data: { bot: { worker: { state: "offline" }, jobs_total: 2 } },
		});
		const cursor = service.status("reviewer").cursor;
		expect(service.status("reviewer").cursor).toEqual(cursor);
		abort.abort();
		await watch.return?.();
	} finally {
		abort.abort();
		clock?.mockRestore();
		if (worker.exitCode === null) worker.kill("SIGKILL");
		await worker.exited;
		await service.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("an expired heartbeat with a surviving process does not silently change public samples", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-live-observer-"));
	const service = new BotService(root, { ensure_worker: async () => {} });
	let clock: { mockRestore(): void } | undefined;
	try {
		const bot = await service.create({ bot_name: "reviewer", cwd: root });
		service.store.claimWorker(bot.bot_id, "live-owner", process.pid);
		const before = service.status("reviewer");
		clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
		const after = service.status("reviewer");
		expect(after.bot.worker).toEqual(before.bot.worker);
		expect(after.cursor).toEqual(before.cursor);
		expect(service.store.events(bot.bot_id, { after: before.cursor }).items).toEqual([]);
	} finally {
		clock?.mockRestore();
		await service.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("offline reconciliation cannot overwrite a replacement worker epoch", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-observer-cas-"));
	const service = new BotService(root, { ensure_worker: async () => {} });
	const worker = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], {
		stdin: "pipe",
		stdout: "ignore",
		stderr: "ignore",
	});
	let clock: { mockRestore(): void } | undefined;
	let reconcile: { mockRestore(): void } | undefined;
	try {
		const bot = await service.create({ bot_name: "reviewer", cwd: root });
		service.store.claimWorker(bot.bot_id, "lost-owner", worker.pid);
		const before = service.status("reviewer");
		const predecessor = service.store.workerLease(bot.bot_id)!;
		worker.kill("SIGKILL");
		await worker.exited;
		clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
		const original = service.store.reconcileOffline.bind(service.store);
		let published: boolean | undefined;
		reconcile = vi.spyOn(service.store, "reconcileOffline").mockImplementationOnce((botId, lease, sample) => {
			expect(lease).toEqual(predecessor);
			expect(service.store.claimWorker(botId, "replacement-owner", process.pid)).toBe(true);
			published = original(botId, lease, sample);
			return published;
		});
		const after = service.status("reviewer");
		expect(published).toBe(false);
		expect(after.bot.worker.state).toBe("online");
		expect(service.store.workerLease(bot.bot_id)).toMatchObject({ owner_id: "replacement-owner" });
		expect(service.store.workerLease(bot.bot_id)!.owner_epoch).not.toBe(predecessor.owner_epoch);
		const events = service.store.events(bot.bot_id, { after: before.cursor }).items;
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "bot.changed", data: { bot: { worker: { state: "online" } } } });
		expect(service.status("reviewer").cursor).toEqual(after.cursor);
	} finally {
		reconcile?.mockRestore();
		clock?.mockRestore();
		if (worker.exitCode === null) worker.kill("SIGKILL");
		await worker.exited;
		await service.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a slow viewer is rejected at a page boundary and recovers committed outcomes from its cursor", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bot-slow-viewer-"));
	const service = new BotService(root, { ensure_worker: async () => {} });
	const watch = service.watch("reviewer")[Symbol.asyncIterator]();
	let clock: { mockRestore(): void } | undefined;
	try {
		const bot = await service.create({ bot_name: "reviewer", cwd: root });
		await watch.next();
		service.store.emit(bot.bot_id, "runtime.notice", { level: "info", message: "Current activity" });
		const delivered = (await watch.next()).value as BotEvent;
		const receipt = await service.submit("reviewer", { command: "submit", input: "Retained work" });
		service.store.finishRequest(bot.bot_id, receipt.request_id, "applied");
		clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
		await expect(watch.next()).rejects.toMatchObject({
			code: "slow_consumer",
			details: { cursor: delivered.cursor, reset_required: false },
		});
		clock.mockRestore();
		let recovered: BotEvent | undefined;
		for await (const frame of service.watch("reviewer", {
			since: delivered.cursor,
			signal: AbortSignal.timeout(1_000),
		})) {
			const event = frame as BotEvent;
			if (event.type === "request.finished" && event.request_id === receipt.request_id) {
				recovered = event;
				break;
			}
		}
		expect(recovered).toMatchObject({
			type: "request.finished",
			request_id: receipt.request_id,
			data: { outcome: "applied" },
		});
	} finally {
		clock?.mockRestore();
		await watch.return?.();
		await service.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});
