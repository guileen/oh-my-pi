import { describe, expect, test } from "bun:test";
import {
	assertGraphWireReplacement,
	compareGraphWireRevisions,
	validateGraphWireImage,
	validateGraphWireRecord,
} from "@oh-my-pi/pi-wire/graph/wire-records";
import type { GraphWireRecord } from "@oh-my-pi/pi-wire/graph";

const bot = { source_id: "bot-source", profile_id: "profile", bot_id: "bot" };
const run = (): Extract<GraphWireRecord, { kind: "run" }> => ({
	kind: "run",
	value: {
		graph_id: "graph",
		graph_run_id: "run",
		definition_revision: "1",
		revision: "1",
		created_at: "2026-11-05T00:00:00Z",
		definition: {
			nodes: [{ node_id: "review", label: "Review", bot, config_revision: "cfg1", acceptance_ref: null }],
			edges: [],
		},
	},
});
const binding = (): Extract<GraphWireRecord, { kind: "binding" }> => ({
	kind: "binding",
	value: {
		binding_id: "binding",
		graph_run_id: "run",
		node_id: "review",
		invocation_id: "invocation",
		attempt: 1,
		job: { ...bot, job_id: "job" },
		config_revision: "cfg1",
		revision: "1",
		acceptance: "pending",
		evidence_refs: [],
		reason: null,
	},
});

describe("Graph wire record identity", () => {
	test("a retry retains both attempts but cannot bind an attempt or Job twice", () => {
		const first = binding();
		const retry = binding();
		retry.value.binding_id = "retry";
		retry.value.attempt = 2;
		retry.value.job.job_id = "job2";
		validateGraphWireImage([retry, first, run()]);
		const rebound = structuredClone(retry);
		rebound.value.attempt = 1;
		expect(() => validateGraphWireImage([run(), first, rebound])).toThrow("more than one binding");
		rebound.value.attempt = 2;
		rebound.value.job.job_id = first.value.job.job_id;
		expect(() => validateGraphWireImage([run(), first, rebound])).toThrow("more than one binding");
	});

	test("changing binding job identity or a captured definition cannot rewrite execution history", () => {
		const before = binding();
		const updated = binding();
		updated.value.revision = "2";
		updated.value.acceptance = "accepted";
		updated.value.evidence_refs = ["evidence"];
		assertGraphWireReplacement(before, updated);
		updated.value.job.job_id = "replacement-job";
		expect(() => assertGraphWireReplacement(before, updated)).toThrow("immutable");
		const captured = run();
		const changed = run();
		changed.value.revision = "2";
		changed.value.definition.nodes[0].label = "Relabeled";
		expect(() => assertGraphWireReplacement(captured, changed)).toThrow("immutable");
	});

	test("an equal revision with a conflicting acceptance is a protocol error", () => {
		const accepted = binding();
		accepted.value.acceptance = "accepted";
		expect(() => assertGraphWireReplacement(binding(), accepted)).toThrow("same revision");
	});

	test("missing Bot identity or changed configuration is not a host-only node", () => {
		const definition = run();
		definition.value.definition.nodes[0].bot = null;
		expect(() => validateGraphWireImage([definition, binding()])).toThrow("frozen Bot node");
		const otherBot = binding();
		otherBot.value.job.bot_id = "recreated-same-name";
		expect(() => validateGraphWireImage([run(), otherBot])).toThrow("frozen Bot node");
		const otherConfig = binding();
		otherConfig.value.config_revision = "changed";
		expect(() => validateGraphWireImage([run(), otherConfig])).toThrow("frozen Bot node");
	});

	test("dangling edges and evidence without an artifact or reference reject rather than imply delivery", () => {
		const dangling = run();
		dangling.value.definition.edges.push({
			edge_id: "edge",
			from_node_id: "review",
			to_node_id: "missing",
			condition_ref: null,
		});
		expect(() => validateGraphWireRecord(dangling)).toThrow("edge");
		const dependency: GraphWireRecord = {
			kind: "dependency",
			value: {
				dependency_id: "dependency",
				graph_run_id: "run",
				edge_id: "edge",
				target_invocation_id: "next",
				target_attempt: 1,
				revision: "1",
				state: "satisfied",
				reason: null,
				evidence: [{ source: bot, job_id: "job", artifact_id: null, ref: null }],
			},
		};
		expect(() => validateGraphWireRecord(dependency)).toThrow("Dependency");
	});

	test("transfers cannot join bindings from a different Run or unrelated edge", () => {
		const definition = run();
		definition.value.definition.nodes.push({
			node_id: "publish",
			label: "Publish",
			bot,
			config_revision: "cfg1",
			acceptance_ref: null,
		});
		definition.value.definition.edges.push({
			edge_id: "edge",
			from_node_id: "review",
			to_node_id: "publish",
			condition_ref: null,
		});
		const target = binding();
		target.value = {
			...target.value,
			binding_id: "target",
			node_id: "publish",
			invocation_id: "publisher",
			job: { ...bot, job_id: "job2" },
		};
		const transfer: Extract<GraphWireRecord, { kind: "transfer" }> = {
			kind: "transfer",
			value: {
				transfer_id: "transfer",
				graph_run_id: "run",
				edge_id: "edge",
				from_binding_id: "binding",
				to_binding_id: "target",
				artifact: { source: bot, job_id: "job", artifact_id: "artifact", ref: null },
				revision: "1",
				state: "delivered",
				reason: null,
				occurred_at: "2026-11-05T00:00:00Z",
			},
		};
		validateGraphWireImage([transfer, target, binding(), definition]);
		transfer.value.from_binding_id = "target";
		expect(() => validateGraphWireImage([definition, binding(), target, transfer])).toThrow("edge bindings");
	});

	test("definition revisions reject ambiguous or opaque encodings before entering a Run image", () => {
		for (const revision of ["01", "-1", "1.0", "definition-1"]) {
			const invalid = run();
			invalid.value.definition_revision = revision;
			expect(() => validateGraphWireRecord(invalid)).toThrow("Run definition");
		}
	});

	test("numeric ordering preserves large revisions and rejects ambiguous decimal encodings", () => {
		expect(compareGraphWireRevisions("99999999999999999999", "100000000000000000000")).toBeLessThan(0);
		expect(compareGraphWireRevisions("10", "9")).toBeGreaterThan(0);
		expect(() => compareGraphWireRevisions("01", "1")).toThrow("revision");
		const invalid = binding();
		invalid.value.attempt = Number.MAX_SAFE_INTEGER + 1;
		expect(() => validateGraphWireRecord(invalid)).toThrow("Binding");
	});
});
