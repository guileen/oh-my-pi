import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphReadProfile, GraphReadProfileError } from "../src/graph/read-profile";
import { SMOKE_TEST_TIMEOUT_MS } from "../src/subprocess/worker-client";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function directory(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-readonly-"));
	roots.push(root);
	return root;
}
async function observe(root: string): Promise<{ exit: number; output: string }> {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/graph/wherdr-observer.ts"), root], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write(JSON.stringify({ run_id: "unknown-run" }));
	child.stdin.end();
	const output = await new Response(child.stdout).text();
	return { exit: await child.exited, output };
}

it(
	"an observation of a missing profile fails without creating the profile",
	async () => {
		const root = path.join(directory(), "missing");
		const result = await observe(root);
		expect(result.exit).not.toBe(0);
		expect(result.output).toBe("");
		expect(fs.existsSync(root)).toBe(false);
	},
	SMOKE_TEST_TIMEOUT_MS,
);

it(
	"an observation refuses unsafe profile permissions without silently repairing them",
	async () => {
		const root = directory();
		fs.chmodSync(root, 0o755);
		const result = await observe(root);
		expect(result.exit).not.toBe(0);
		expect(result.output).toBe("");
		expect(fs.statSync(root).mode & 0o777).toBe(0o755);
		expect(fs.existsSync(path.join(root, "graphs.sqlite"))).toBe(false);
	},
	SMOKE_TEST_TIMEOUT_MS,
);

it(
	"an observation of an old database fails without installing or migrating Host tables",
	async () => {
		const root = directory();
		const filename = path.join(root, "graphs.sqlite");
		const db = new Database(filename);
		db.exec("CREATE TABLE old_data (value TEXT); INSERT INTO old_data VALUES ('preserve');");
		db.close();
		fs.chmodSync(filename, 0o600);
		const before = Bun.SHA256.hash(await Bun.file(filename).bytes(), "hex");
		const result = await observe(root);
		expect(result.exit).not.toBe(0);
		expect(result.output).toBe("");
		expect(Bun.SHA256.hash(await Bun.file(filename).bytes(), "hex")).toBe(before);
		const reader = new Database(filename, { readonly: true });
		try {
			expect(reader.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([
				{ name: "old_data" },
			]);
		} finally {
			reader.close();
		}
	},
	SMOKE_TEST_TIMEOUT_MS,
);

function database(): { root: string; filename: string } {
	const root = directory();
	const filename = path.join(root, "graphs.sqlite");
	const db = new Database(filename);
	db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('retained');");
	db.close();
	fs.chmodSync(filename, 0o600);
	return { root, filename };
}

it("a readonly connection rejects writes and detects database replacement before releasing more data", () => {
	const { root, filename } = database();
	const reader = new GraphReadProfile(root);
	try {
		expect(reader.db.query("SELECT value FROM marker").get()).toEqual({ value: "retained" });
		expect(() => reader.db.query("DELETE FROM marker").run()).toThrow();
		fs.renameSync(filename, `${filename}.old`);
		fs.copyFileSync(`${filename}.old`, filename);
		expect(() => reader.assertAccess()).toThrow(GraphReadProfileError);
	} finally {
		reader.close();
	}
});

it("unsafe database permissions, symlinks and WAL files are denied without repair", () => {
	const { root, filename } = database();
	fs.chmodSync(filename, 0o644);
	expect(() => new GraphReadProfile(root)).toThrow(GraphReadProfileError);
	expect(fs.statSync(filename).mode & 0o777).toBe(0o644);
	fs.chmodSync(filename, 0o600);
	fs.renameSync(filename, `${filename}.real`);
	fs.symlinkSync(`${filename}.real`, filename);
	expect(() => new GraphReadProfile(root)).toThrow(GraphReadProfileError);
	fs.unlinkSync(filename);
	fs.renameSync(`${filename}.real`, filename);
	fs.writeFileSync(`${filename}-wal`, "", { mode: 0o644 });
	expect(() => new GraphReadProfile(root)).toThrow(GraphReadProfileError);
	expect(fs.statSync(`${filename}-wal`).mode & 0o777).toBe(0o644);
});
