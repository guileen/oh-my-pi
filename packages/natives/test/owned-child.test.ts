import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OwnedChild, type OwnedChildPollResult } from "../native/index.js";

async function waitForExit(child: OwnedChild): Promise<OwnedChildPollResult> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const status = child.poll();
		if (!status.running) return status;
		if (Date.now() >= deadline) throw new Error("owned child did not exit");
		// Native OS children cannot use fake JS time; yield until the real exit
		// condition is observable, rather than guessing a completion duration.
		await Bun.sleep(5);
	}
}

const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("OwnedChild native ownership", () => {
	it("uses only explicit environment and appends both output streams", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-child-"));
		const outputPath = path.join(cwd, "output");
		let child: OwnedChild | undefined;
		try {
			await fs.writeFile(outputPath, "prefix\n");
			child = OwnedChild.spawn({
				application: "/usr/bin/env",
				args: [],
				cwd,
				env: { OWNED_ONLY: "explicit" },
				outputPath,
			});
			expect(child.pid).toBeGreaterThan(0);
			expect(await waitForExit(child)).toEqual({ running: false, exitCode: 0, signal: null });
			expect(await fs.readFile(outputPath, "utf8")).toBe("prefix\nOWNED_ONLY=explicit\n");
			child = OwnedChild.spawn({
				application: "/bin/sh",
				args: ["-c", "printf 'stdout\\n'; printf 'stderr\\n' >&2; pwd"],
				cwd,
				env: {},
				outputPath,
			});
			expect(await waitForExit(child)).toEqual({ running: false, exitCode: 0, signal: null });
			expect(await fs.readFile(outputPath, "utf8")).toBe(
				`prefix\nOWNED_ONLY=explicit\nstdout\nstderr\n${await fs.realpath(cwd)}\n`,
			);
		} finally {
			child?.signal(9, true);
			if (child) await waitForExit(child);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("serializes input, exit observation and repeated post-reap signals", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-child-"));
		const outputPath = path.join(cwd, "output");
		const child = OwnedChild.spawn({
			application: "/bin/sh",
			args: ["-c", "read line; printf '%s\\n' \"$line\"; exit 19"],
			cwd,
			env: {},
			outputPath,
		});
		try {
			expect(child.poll()).toEqual({ running: true, exitCode: null, signal: null });
			child.write("héllo\n");
			const terminal = { running: false, exitCode: 19, signal: null };
			expect(await waitForExit(child)).toEqual(terminal);
			for (let index = 0; index < 32; index++) {
				expect(child.signal(9, false)).toBeFalse();
				expect(child.signal(9, true)).toBeFalse();
				expect(child.poll()).toEqual(terminal);
			}
			expect(() => child.write("after exit")).toThrow();
			expect(await fs.readFile(outputPath, "utf8")).toBe("héllo\n");
		} finally {
			child.signal(9, true);
			await waitForExit(child);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("reports signal termination and bounds queued input without blocking", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-child-"));
		const child = OwnedChild.spawn({
			application: "/bin/sh",
			args: ["-c", "read line"],
			cwd,
			env: {},
			outputPath: path.join(cwd, "output"),
		});
		try {
			expect(() => child.write("x".repeat(65_537))).toThrow("64 KiB");
			expect(child.signal(9, true)).toBeTrue();
			expect(await waitForExit(child)).toEqual({ running: false, exitCode: null, signal: 9 });
			expect(child.signal(9, true)).toBeFalse();
		} finally {
			child.signal(9, true);
			await waitForExit(child);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("finishes bounded rotation before publishing the terminal outcome", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-child-"));
		const outputPath = path.join(cwd, "output");
		const previousOutputPath = path.join(cwd, "previous");
		const child = OwnedChild.spawn({
			application: "/bin/sh",
			args: ["-c", "printf 'abcdefghijkl'; printf 'mnop' >&2; printf 'END'"],
			cwd,
			env: {},
			outputPath,
			maxOutputBytes: 8,
			previousOutputPath,
		});
		try {
			expect(await waitForExit(child)).toEqual({ running: false, exitCode: 0, signal: null });
			expect(await fs.readFile(previousOutputPath, "utf8")).toBe("ijklmnop");
			expect(await fs.readFile(outputPath, "utf8")).toBe("END");
		} finally {
			child.signal(9, true);
			await waitForExit(child);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("preserves safe output limits above u32 instead of truncating them", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-owned-child-wide-limit-"));
		const outputPath = path.join(cwd, "output");
		const child = OwnedChild.spawn({
			application: "/bin/sh",
			args: ["-c", "printf 'complete-output'"],
			cwd,
			env: {},
			outputPath,
			maxOutputBytes: 2 ** 32 + 1,
			previousOutputPath: path.join(cwd, "previous"),
		});
		try {
			expect(await waitForExit(child)).toEqual({ running: false, exitCode: 0, signal: null });
			expect(await fs.readFile(outputPath, "utf8")).toBe("complete-output");
		} finally {
			child.signal(9, true);
			await waitForExit(child);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

if (process.platform === "win32") {
	it("rejects unsupported owned session/group spawning on Windows", () => {
		expect(() =>
			OwnedChild.spawn({
				application: process.execPath,
				args: [],
				cwd: process.cwd(),
				env: {},
				outputPath: "unused-owned-output",
			}),
		).toThrow("Unix owned session/group support");
	});
}
