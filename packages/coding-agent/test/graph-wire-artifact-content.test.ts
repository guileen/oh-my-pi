import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphWireError, type GraphRef, type GraphWireRecord } from "@oh-my-pi/pi-wire/graph";
import { GraphArtifactRegistry } from "../src/graph/artifacts";
import { GraphReadProfile } from "../src/graph/read-profile";
import { GraphWireArtifactContentReader } from "../src/graph/wire-artifact-content";
import { GraphWireLedger } from "../src/graph/wire-ledger";
import { GraphWireReadBridge, type GraphWireReadFrame } from "../src/graph/wire-read-bridge";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const unknown = { availability: "unknown", media_type: null, content: null } as const;
const unavailable = (availability: "expired" | "missing") => ({ availability, media_type: null, content: null });
const instant = "2026-11-05T00:00:00.000Z";
const extension = "graph.execution.v1";
const bot = { source_id: "bot-source", profile_id: "profile", bot_id: "bot" };
const source = {
	source_id: "graph-source",
	kind: "graph" as const,
	profile_id: null,
	bot_id: null,
	capabilities: [extension],
};

async function collect(input: AsyncIterable<GraphWireReadFrame>) {
	const frames: GraphWireReadFrame[] = [];
	for await (const frame of input) frames.push(frame);
	return frames;
}
const request = (ref: string, runId = "run", sourceId = source.source_id) => ({
	protocol: "omp.graph.v1",
	type: "graph.artifact.get",
	message_id: crypto.randomUUID(),
	source_id: sourceId,
	graph_run_id: runId,
	ref,
	page_token: null,
	limit: 1,
});
const hello = {
	protocol: "omp.graph.v1",
	type: "hello",
	message_id: "hello",
	supported_protocols: ["omp.graph.v1"],
	extensions: [extension],
};

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-wire-artifact-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const filename = path.join(root, "graphs.sqlite");
	const db = new Database(filename);
	cleanups.push(() => db.close());
	fs.chmodSync(filename, 0o600);
	let artifactAuthorized = true;
	let onArtifactRead: (() => void | Promise<void>) | undefined;
	const registry = new GraphArtifactRegistry({
		root,
		database: db,
		maxBytes: 1024 * 1024,
		authorize: async (principal, action, scope) => {
			if (action === "read") await onArtifactRead?.();
			return principal === "viewer" && artifactAuthorized && scope.includes("private-output");
		},
	});
	db.exec("CREATE TABLE graph_schedule_states (run_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
	const ledger = new GraphWireLedger(db);
	const reader = new GraphWireArtifactContentReader(db, {
		artifacts: registry.store,
		principal: "viewer",
		maxBytes: 1024,
	});
	function publish(
		runId: string,
		reference: GraphRef,
		sourceId = source.source_id,
		family: "output" | "input" = "output",
	) {
		ledger.registerSource(sourceId);
		const records: GraphWireRecord[] = [
			{
				kind: "run",
				value: {
					graph_id: "graph",
					graph_run_id: runId,
					definition_revision: "1",
					revision: "1",
					created_at: instant,
					definition: {
						nodes: [{ node_id: "node", label: "Node", bot, config_revision: "1", acceptance_ref: null }],
						edges: [],
					},
				},
			},
		];
		if (family === "output")
			records.push({
				kind: "binding",
				value: {
					binding_id: `attempt-${runId}`,
					graph_run_id: runId,
					node_id: "node",
					invocation_id: `invocation-${runId}`,
					attempt: 1,
					job: { ...bot, job_id: `job-${runId}` },
					config_revision: "1",
					revision: "1",
					acceptance: "accepted",
					evidence_refs: [reference.id],
					reason: null,
				},
			});
		else
			records.push(
				{
					kind: "execution_run",
					value: {
						graph_run_id: runId,
						revision: "1",
						state: "running",
						reason: null,
						snapshot_ref: { id: "snapshot", digest: `sha256:${"1".repeat(64)}` },
						budget_refs: [],
						decision_refs: [],
					},
				},
				{
					kind: "execution_member",
					value: {
						graph_run_id: runId,
						member_id: "member",
						revision: "1",
						label: "Member",
						bot,
						duty: "general",
						model_binding_ref: { id: "model", digest: `sha256:${"2".repeat(64)}` },
						base_snapshot_ref: { id: "base", digest: `sha256:${"3".repeat(64)}` },
						communication_targets: [],
					},
				},
				{
					kind: "execution_invocation",
					value: {
						graph_run_id: runId,
						node_id: "node",
						invocation_id: `invocation-${runId}`,
						revision: "1",
						member_id: "member",
						kind: "bot",
						origin: "executed",
						iteration: 0,
						scope_id: "root",
						parent_invocation_id: null,
						state: "ready",
						selected_outcome: null,
						input_refs: [reference.id],
						upstream_attempt_ids: [],
						wait_reason: null,
						current_attempt_id: null,
					},
				},
			);
		db.transaction(() => {
			db.query("INSERT INTO graph_schedule_states VALUES (?,?)").run(
				runId,
				JSON.stringify({
					run_state: "running",
					run_inputs: family === "input" ? { input: reference } : {},
					invocations: [
						{
							id: `invocation-${runId}`,
							node: "node",
							attempt_id: `attempt-${runId}`,
							outputs: family === "output" ? { result: reference } : {},
							ready: { inputs: family === "input" ? { input: reference } : {} },
						},
					],
				}),
			);
			ledger.publish(sourceId, records, instant);
		})();
	}
	async function artifact(
		content: string | Uint8Array = "Exact **registered** text.\n雪 🦉",
		mediaType = "text/markdown",
	) {
		const expected = {
			media_type: mediaType,
			producer_attempt_id: "attempt-run",
			source_ref: null,
			access_scope: ["private-output"],
		};
		const value = await registry.store.publish(
			"viewer",
			typeof content === "string" ? new TextEncoder().encode(content) : content,
			expected,
		);
		await registry.register([{ artifact: value, expected }]);
		return value;
	}
	function bridge(detailReader = reader) {
		let authorized = true;
		const value = new GraphWireReadBridge(ledger, {
			principal: "viewer",
			catalog: () => (authorized ? { generation: "grant", sources: [source] } : null),
			authorize: (_principal, scope) =>
				authorized && scope.graph_run_id === "run" ? { generation: "grant" } : null,
			maxSubscriptions: 1,
			maxPageTokens: 1,
			pageSize: 1,
			extensions: [extension],
			artifactContents: detailReader,
		});
		return {
			value,
			revoke: () => {
				authorized = false;
			},
		};
	}
	return {
		root,
		db,
		registry,
		ledger,
		reader,
		artifact,
		publish,
		bridge,
		onRead: (callback: () => void | Promise<void>) => {
			onArtifactRead = callback;
		},
		revokeArtifact: () => {
			artifactAuthorized = false;
		},
	};
}

it("serves complete registered text through real publication, registry, and negotiated bridge", async () => {
	const f = fixture();
	const text = "Exact **registered** text.\n雪 🦉";
	const artifact = await f.artifact(text);
	f.publish("run", artifact);
	const { value: bridge } = f.bridge();
	await collect(bridge.handle(hello));
	expect(await collect(bridge.handle(request(artifact.id)))).toMatchObject([
		{
			type: "graph.artifact",
			ref: artifact.id,
			availability: "available",
			media_type: "text/markdown",
			content: text,
		},
	]);
});

it("preserves BOM and CRLF in complete UTF-8 artifact content", async () => {
	const f = fixture();
	const text = "\uFEFF# 方案\r\n雪 🦉\r\n";
	const artifact = await f.artifact(text);
	f.publish("run", artifact);
	expect(await f.reader.read(source.source_id, "run", artifact.id)).toMatchObject({ content: text });
});

it("does not resolve an old binding through a replacement attempt's outputs", async () => {
	const f = fixture();
	const artifact = await f.artifact("replacement attempt");
	f.publish("run", artifact);
	const row = f.db.query("SELECT data FROM graph_schedule_states WHERE run_id='run'").get() as { data: string };
	const state = JSON.parse(row.data);
	state.invocations[0].attempt_id = "replacement-attempt";
	f.db.query("UPDATE graph_schedule_states SET data=? WHERE run_id='run'").run(JSON.stringify(state));
	await expect(f.reader.read(source.source_id, "run", artifact.id)).rejects.toMatchObject({ code: "scope_denied" });
});

it("withholds output content if its admitted attempt changes during the awaited read", async () => {
	const f = fixture();
	const artifact = await f.artifact("superseded attempt secret");
	f.publish("run", artifact);
	f.onRead(() => {
		const row = f.db.query("SELECT data FROM graph_schedule_states WHERE run_id='run'").get() as { data: string };
		const state = JSON.parse(row.data);
		state.invocations[0].attempt_id = "replacement-attempt";
		f.db.query("UPDATE graph_schedule_states SET data=? WHERE run_id='run'").run(JSON.stringify(state));
	});
	const { value: bridge } = f.bridge();
	await collect(bridge.handle(hello));
	const frames = await collect(bridge.handle(request(artifact.id)));
	expect(frames).toMatchObject([{ type: "error", error: { code: "scope_denied" } }]);
	expect(JSON.stringify(frames)).not.toContain("superseded attempt secret");
});

it("withholds input content withdrawn while the artifact store read is pending", async () => {
	const f = fixture();
	const artifact = await f.artifact("withdrawn input secret");
	f.publish("run", artifact, source.source_id, "input");
	f.onRead(() => {
		const row = f.db.query("SELECT data FROM graph_schedule_states WHERE run_id='run'").get() as { data: string };
		const state = JSON.parse(row.data);
		state.invocations[0].ready.inputs = {};
		f.db.query("UPDATE graph_schedule_states SET data=? WHERE run_id='run'").run(JSON.stringify(state));
	});
	await expect(f.reader.read(source.source_id, "run", artifact.id)).rejects.toMatchObject({ code: "scope_denied" });
});

it("resolves immutable published input refs from persisted invocation inputs", async () => {
	const f = fixture();
	const artifact = await f.artifact("input");
	f.publish("run", artifact, source.source_id, "input");
	expect(await f.reader.read(source.source_id, "run", artifact.id)).toEqual({
		availability: "available",
		media_type: "text/markdown",
		content: "input",
	});
});

it("denies foreign Run/source and registered-but-unpublished refs identically", async () => {
	const f = fixture();
	const own = await f.artifact("own");
	const other = await f.artifact("foreign");
	const unpublished = await f.artifact("unpublished");
	f.publish("run", own);
	f.publish("other-run", other);
	f.publish("foreign-run", other, "foreign-source");
	for (const [sourceId, runId, ref] of [
		[source.source_id, "run", other.id],
		[source.source_id, "other-run", own.id],
		["foreign-source", "run", own.id],
		[source.source_id, "run", unpublished.id],
	]) {
		await expect(f.reader.read(sourceId!, runId!, ref!)).rejects.toMatchObject({
			code: "scope_denied",
			message: "Protected Graph content is outside the requested scope",
		});
	}
});

it("does not turn published snapshot/model refs or generic paths into content", async () => {
	const f = fixture();
	const artifact = await f.artifact();
	f.publish("run", artifact);
	const protectedArtifact = await f.artifact("protected snapshot credentials");
	const other = { id: "other-model", digest: `sha256:${"0".repeat(64)}` };
	f.db.transaction(() =>
		f.ledger.publish(
			source.source_id,
			[
				{
					kind: "execution_run",
					value: {
						graph_run_id: "run",
						revision: "1",
						state: "running",
						reason: null,
						snapshot_ref: protectedArtifact,
						budget_refs: [],
						decision_refs: [],
					},
				},
				{
					kind: "execution_member",
					value: {
						graph_run_id: "run",
						member_id: "member",
						revision: "1",
						label: "Member",
						bot,
						duty: "general",
						model_binding_ref: other,
						base_snapshot_ref: protectedArtifact,
						communication_targets: [],
					},
				},
			],
			instant,
		),
	)();
	for (const ref of [protectedArtifact.id, other.id, "/etc/passwd", "graph_run_snapshots", "authorization"]) {
		await expect(f.reader.read(source.source_id, "run", ref)).rejects.toBeInstanceOf(GraphWireError);
	}
});

it("reports missing and expired registered content without fabricated bytes", async () => {
	for (const state of ["missing", "expired"] as const) {
		const f = fixture();
		const artifact = await f.artifact();
		f.publish("run", artifact);
		f.registry.markUnavailable(artifact, state);
		expect(await f.reader.read(source.source_id, "run", artifact.id)).toEqual(unavailable(state));
		const { value: bridge } = f.bridge();
		await collect(bridge.handle(hello));
		expect(await collect(bridge.handle(request(artifact.id)))).toMatchObject([
			{ type: "graph.artifact", ...unavailable(state) },
		]);
	}
});

it("uses store digest verification and reports missing physical files/registry entries", async () => {
	for (const fault of ["digest", "file", "registry", "stored-digest"] as const) {
		const f = fixture();
		const artifact = await f.artifact("immutable");
		f.publish("run", artifact);
		const filename = path.join(f.root, "artifacts", artifact.id);
		if (fault === "digest") {
			fs.chmodSync(filename, 0o600);
			fs.writeFileSync(filename, "corrupted");
		} else if (fault === "file") fs.unlinkSync(filename);
		else if (fault === "registry") f.db.query("DELETE FROM graph_artifacts WHERE id=?").run(artifact.id);
		else {
			const schedule = f.db.query("SELECT data FROM graph_schedule_states WHERE run_id='run'").get() as {
				data: string;
			};
			const state = JSON.parse(schedule.data);
			state.invocations[0].outputs.result.digest = `sha256:${"0".repeat(64)}`;
			f.db.query("UPDATE graph_schedule_states SET data=? WHERE run_id='run'").run(JSON.stringify(state));
		}
		expect(await f.reader.read(source.source_id, "run", artifact.id)).toEqual(
			fault === "digest" || fault === "stored-digest" ? unknown : unavailable("missing"),
		);
	}
});

it("rejects binary, oversized, non-UTF-8, and non-UTF-8 declared text explicitly as unknown", async () => {
	for (const [bytes, mediaType] of [
		[new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"],
		[new Uint8Array([0xff, 0xfe]), "text/plain"],
		[new Uint8Array([65, 0, 66]), "text/plain"],
		[new TextEncoder().encode("x".repeat(1025)), "text/plain"],
		[new TextEncoder().encode("not UTF-16"), "text/plain; charset=utf-16"],
	] as const) {
		const f = fixture();
		const artifact = await f.artifact(bytes, mediaType);
		f.publish("run", artifact);
		expect(await f.reader.read(source.source_id, "run", artifact.id)).toEqual(unknown);
	}
});

it("does not release content when artifact permission is revoked during the awaited store read", async () => {
	const f = fixture();
	const artifact = await f.artifact("revoked artifact secret");
	f.publish("run", artifact);
	let checks = 0;
	f.onRead(() => {
		if (++checks === 2) f.revokeArtifact();
	});
	const { value: bridge } = f.bridge();
	await collect(bridge.handle(hello));
	const frames = await collect(bridge.handle(request(artifact.id)));
	expect(checks).toBe(2);
	expect(frames).toMatchObject([{ type: "error", error: { code: "scope_denied" } }]);
	expect(JSON.stringify(frames)).not.toContain("revoked artifact secret");
});

it("rechecks bridge authorization after an awaited real artifact read", async () => {
	const f = fixture();
	const artifact = await f.artifact("revoked bridge secret");
	f.publish("run", artifact);
	const { value: bridge, revoke } = f.bridge();
	f.onRead(async () => {
		await Promise.resolve();
		revoke();
	});
	await collect(bridge.handle(hello));
	const frames = await collect(bridge.handle(request(artifact.id)));
	expect(frames).toMatchObject([{ type: "error", error: { code: "scope_denied" } }]);
	expect(JSON.stringify(frames)).not.toContain("revoked bridge secret");
});

it("reads an existing readonly profile without installing schema or mutating the registry", async () => {
	const f = fixture();
	const artifact = await f.artifact("readonly text");
	f.publish("run", artifact);
	const profile = new GraphReadProfile(f.root);
	try {
		const schema = profile.db.query("SELECT name,sql FROM sqlite_master ORDER BY name").all();
		const changes = profile.db.query("SELECT total_changes() AS changes").get();
		const reader = new GraphWireArtifactContentReader(profile.db, {
			artifacts: f.registry.store,
			principal: "viewer",
			maxBytes: 1024,
		});
		expect(await reader.read(source.source_id, "run", artifact.id)).toMatchObject({
			availability: "available",
			content: "readonly text",
		});
		expect(profile.db.query("SELECT total_changes() AS changes").get()).toEqual(changes);
		expect(profile.db.query("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
	} finally {
		profile.close();
	}
});

it("does not initialize an empty observer database", async () => {
	const db = new Database(":memory:");
	cleanups.push(() => db.close());
	db.exec("PRAGMA query_only=ON");
	const f = fixture();
	const reader = new GraphWireArtifactContentReader(db, {
		artifacts: f.registry.store,
		principal: "viewer",
		maxBytes: 1024,
	});
	expect(await reader.read(source.source_id, "run", "not-an-artifact")).toEqual(unknown);
	expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
	expect(db.query("SELECT total_changes() AS changes").get()).toEqual({ changes: 0 });
});
