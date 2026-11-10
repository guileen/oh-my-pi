import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GraphRunStore, type GraphPreparedRun, type GraphStartRequest } from "../src/graph/store";
import { GraphWireLedger } from "../src/graph/wire-ledger";
import { graphWireRecordKey } from "@oh-my-pi/pi-wire/graph/wire-records";
import { GraphWireError } from "@oh-my-pi/pi-wire/graph";
import { BotStore } from "../src/bots/store";
import { BotWorker } from "../src/bots/worker";
import { GraphHost } from "../src/graph/host";
import type { GraphDispatchIntent } from "../src/graph/store";
import { QueueAdapter, type QueueExecutionRequest, type QueueObservation } from "../src/graph/executors/queue";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 };
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const ref = (id: string) => ({ id, digest: `sha256:${id}` });
function fixture(change: (content: string) => string = content => content) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-publication-"));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const store = new GraphRunStore(limits, root);
	cleanups.push(() => store.close());
	const content = change(`---
format: omp.graph/v1
name: publication
members:
  researcher: {role: '#role', model: model, base: isolated, duty: research, permissions: {read: [], write: [], execute: []}}
nodes:
  research: {kind: bot, member: researcher, task: '#task'}
  approval: {kind: human, task: '#task'}
edges:
  - {id: handoff, from: research, to: approval}
---
## role
Research.
## task
Work.
`);
	const receipt = store.definitions.mutate({
		version: 1,
		request_key: "definition",
		operation: "import",
		target_id: null,
		if_revision: null,
		payload: { content },
	});
	if (receipt.error) throw new Error(receipt.error.message);
	const definition = store.definitions.get(receipt.target_id!)!;
	const request: GraphStartRequest = {
		version: 1,
		request_key: "run",
		operation: "start",
		target_id: definition.graph_id,
		if_revision: definition.revision,
		payload: { inputs: {}, authorization_ref: ref("authorization") },
	};
	const prepared: GraphPreparedRun = {
		graph_id: definition.graph_id,
		definition_revision: definition.revision,
		definition_digest: definition.digest,
		authorization_ref: ref("authorization"),
		inputs: {},
		executors: {},
		members: {
			researcher: {
				provider: "provider",
				model: "model",
				configuration_revision: "7",
				base: "isolated",
				base_snapshot_ref: ref("base"),
				role_ref: ref("role"),
				skill_refs: [],
				rule_refs: [],
			},
		},
		observation: {
			source_id: "graph-source",
			members: {
				researcher: {
					bot: { source_id: "research-source", profile_id: "profile", bot_id: "bot-id" },
					config_revision: "3",
					model_binding_ref: ref("model-binding"),
				},
			},
		},
	};
	const db = new Database(path.join(root, "graphs.sqlite"));
	cleanups.push(() => db.close());
	const ledger = new GraphWireLedger(db, { readOnly: true });
	return { root, store, db, ledger, request, prepared };
}

it("freezes the trusted Bot identity before Job admission and never backfills old Runs", () => {
	const { store, ledger, request, prepared } = fixture();
	const withoutObservation = structuredClone(prepared);
	delete withoutObservation.observation;
	const unobserved = store.start({ ...request, request_key: "unobserved" }, withoutObservation);
	expect(unobserved.state).toBe("accepted");
	const started = store.start(request, prepared);
	expect(started.state).toBe("accepted");
	const run = store.getRun(started.target_id!)!;
	const source = ledger.snapshot("graph-source");
	const published = source.records.find(record => record.kind === "run");
	if (published?.kind !== "run") throw new Error("Missing frozen wire Run");
	expect(published.value.definition.nodes).toEqual([
		{
			node_id: "research",
			label: "research",
			bot: { source_id: "research-source", profile_id: "profile", bot_id: "bot-id" },
			config_revision: "3",
			acceptance_ref: null,
		},
		{ node_id: "approval", label: "approval", bot: null, config_revision: null, acceptance_ref: null },
	]);
	prepared.observation!.members.researcher.bot.bot_id = "recreated-bot";
	prepared.members.researcher.configuration_revision = "8";
	expect(store.getSnapshot(run.snapshot_ref)?.observation?.members.researcher.bot.bot_id).toBe("bot-id");
	expect(store.start(request, prepared)).toEqual(started);
	expect(ledger.snapshot("graph-source")).toEqual(source);
	expect(source.records.some(record => record.value.graph_run_id === unobserved.target_id)).toBe(false);
	expect(store.getDispatchIntents(run.id)).toEqual([]);
});

it("rejects incomplete provenance and durable source ID reassignment without creating a Run", () => {
	const { store, ledger, request, prepared } = fixture();
	expect(
		store.start(
			{ ...request, request_key: "missing" },
			{ ...prepared, observation: { source_id: "graph-source", members: {} } },
		).error?.code,
	).toBe("capability_unavailable");
	expect(store.listHostRuns()).toEqual([]);
	const accepted = store.start(request, prepared);
	expect(accepted.state).toBe("accepted");
	const before = ledger.snapshot("graph-source");
	prepared.observation!.members.researcher.bot.bot_id = "other-bot";
	expect(store.start({ ...request, request_key: "rebind" }, prepared).error?.code).toBe("input_stale");
	expect(store.listHostRuns().map(run => run.id)).toEqual([accepted.target_id!]);
	expect(ledger.snapshot("graph-source")).toEqual(before);
});

it("rolls back the Run, receipt and source registration if wire publication cannot commit", () => {
	const { store, db, ledger, request, prepared } = fixture();
	db.exec(
		"CREATE TRIGGER reject_wire BEFORE INSERT ON graph_wire_events BEGIN SELECT RAISE(ABORT,'wire unavailable'); END",
	);
	expect(() => store.start(request, prepared)).toThrow("wire unavailable");
	expect(store.listHostRuns()).toEqual([]);
	expect(store.getStartReceipt(request)).toBeNull();
	expect(db.query("SELECT source_id FROM graph_wire_sources").all()).toEqual([]);
	expect(db.query("SELECT source_id FROM graph_wire_source_identities").all()).toEqual([]);
	db.exec("DROP TRIGGER reject_wire");
	const accepted = store.start(request, prepared);
	expect(accepted.state).toBe("accepted");
	expect(
		ledger
			.snapshot("graph-source")
			.records.filter(record => record.kind === "run")
			.map(record => record.value.graph_run_id),
	).toEqual([accepted.target_id!]);
});

it("reopens the original wire history without applying current preflight bindings", () => {
	const { root, store, request, prepared } = fixture();
	const accepted = store.start(request, prepared);
	expect(accepted.state).toBe("accepted");
	const reopened = new Database(path.join(root, "graphs.sqlite"), { readonly: true });
	try {
		const ledger = new GraphWireLedger(reopened, { readOnly: true });
		const snapshot = ledger.snapshot("graph-source", accepted.target_id!);
		expect(snapshot.cursor.seq).toBe("1");
		const record = snapshot.records.find(record => record.kind === "run");
		if (record?.kind !== "run") throw new Error("Missing recovered Run");
		expect(record.value.definition.nodes[0].bot?.bot_id).toBe("bot-id");
		const history = ledger.stateAt("graph-source", accepted.target_id!, snapshot.cursor);
		expect(new Map(history.records.map(record => [graphWireRecordKey(record), record]))).toEqual(
			new Map(snapshot.records.map(record => [graphWireRecordKey(record), record])),
		);
	} finally {
		reopened.close();
	}
});

it("publishes ready without an invented attempt, then atomically records budget consumption and downstream causality", () => {
	const { store, ledger, request, prepared } = fixture(content =>
		content
			.replace("task: '#task'}", "task: '#task', consume: [work]}")
			.replace("edges:\n", "budgets:\n  work: {scope: run, limit: 2}\nedges:\n"),
	);
	const started = store.start(request, prepared);
	expect(started.state).toBe("accepted");
	const runId = started.target_id!;
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const ready = ledger.snapshot("graph-source", runId);
	expect(ready.records.filter(record => record.kind === "execution_attempt")).toEqual([]);
	expect(
		ready.records.find(record => record.kind === "execution_invocation" && record.value.node_id === "research"),
	).toMatchObject({
		value: { state: "ready", current_attempt_id: null },
	});
	const dispatched = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	expect(
		ledger.snapshot("graph-source", runId).records.find(record => record.kind === "execution_budget"),
	).toMatchObject({
		value: { limit: 2, consumed: 1 },
	});
	expect(store.claimDispatch(owner.owner_id, owner.epoch, dispatched.id)?.state).toBe("submitting");
	expect(
		store.observeDispatch(owner.owner_id, owner.epoch, dispatched.id, "accepted", {
			job_id: "job-1",
			bot_id: "bot-id",
		}),
	).toBe(true);
	const accepted = ledger.snapshot("graph-source", runId);
	expect(() =>
		store.observeDispatch(owner.owner_id, owner.epoch, dispatched.id, "accepted", {
			job_id: "replacement-job",
			bot_id: "bot-id",
		}),
	).toThrow(GraphWireError);
	expect(ledger.snapshot("graph-source", runId)).toEqual(accepted);
	expect(store.getDispatchIntents(runId)[0].observation).toEqual({ job_id: "job-1", bot_id: "bot-id" });
	expect(
		store.completeAttempt(owner.owner_id, owner.epoch, {
			run_id: runId,
			invocation_id: dispatched.invocation_id,
			attempt_id: dispatched.attempt_id,
			fence: owner.epoch,
			state: "succeeded",
			outcome: "done",
		}),
	).toBe(true);
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("routed");
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
	const current = ledger.snapshot("graph-source", runId);
	expect(current.records.find(record => record.kind === "execution_attempt")).toMatchObject({
		value: { state: "succeeded", job: { job_id: "job-1", bot_id: "bot-id", profile_id: "profile" } },
	});
	expect(
		current.records.find(record => record.kind === "execution_invocation" && record.value.node_id === "approval"),
	).toMatchObject({
		value: { state: "ready", upstream_attempt_ids: [dispatched.attempt_id], current_attempt_id: null },
	});
	expect(
		ledger
			.stateAt("graph-source", runId, ready.cursor)
			.records.find(record => record.kind === "execution_invocation" && record.value.node_id === "approval"),
	).toMatchObject({
		value: { state: "pending", upstream_attempt_ids: [] },
	});
	const events = ledger.events("graph-source", { after: ready.cursor, runId });
	expect(
		events.events
			.flatMap(event => event.records)
			.some(record => record.kind === "execution_member" || record.kind === "run"),
	).toBe(false);
	store.schedule(runId, owner.owner_id, owner.epoch);
	expect(ledger.snapshot("graph-source", runId).records.find(record => record.kind === "dependency")).toMatchObject({
		value: { edge_id: "handoff", state: "satisfied", target_attempt: 1 },
	});
});

it("retains the accepted execution identity across unknown recovery and rolls back failed schedule publication", () => {
	const { store, db, ledger, request, prepared } = fixture(content =>
		content.replace("kind: bot, member: researcher", "kind: program, executor: program"),
	);
	prepared.executors.program = ref("program");
	const started = store.start(request, prepared);
	const runId = started.target_id!;
	const owner = store.claimHost()!;
	const before = ledger.snapshot("graph-source", runId);
	const originalRun = store.getRun(runId);
	db.exec(
		"CREATE TRIGGER reject_schedule_wire BEFORE INSERT ON graph_wire_events BEGIN SELECT RAISE(ABORT,'wire blocked'); END",
	);
	expect(() => store.schedule(runId, owner.owner_id, owner.epoch)).toThrow("wire blocked");
	expect(store.getRun(runId)).toEqual(originalRun);
	expect(store.getScheduleState(runId)?.invocations[0].state).toBe("pending");
	expect(ledger.snapshot("graph-source", runId)).toEqual(before);
	db.exec("DROP TRIGGER reject_schedule_wire");
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "accepted", { execution_ref: "program-execution" });
	expect(() =>
		store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "accepted", {
			execution_ref: "replacement-program",
		}),
	).toThrow(GraphWireError);
	expect(store.getDispatchIntents(runId)[0].observation).toEqual({ execution_ref: "program-execution" });
	store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "unknown", { reason: "Host lost" });
	const records = ledger.snapshot("graph-source", runId).records;
	expect(records.find(record => record.kind === "execution_run")).toMatchObject({ value: { state: "held" } });
	expect(records.find(record => record.kind === "execution_attempt")).toMatchObject({
		value: { state: "unknown", execution_ref: "program-execution", job: null },
	});
	expect(records.some(record => record.kind === "binding")).toBe(false);
});

it("atomically publishes consultation rounds without leaking text or inventing topology for auxiliary executions", () => {
	const { store, db, ledger, request, prepared } = fixture(content =>
		content
			.replace(
				"nodes:\n",
				"  reviewer: {role: '#role', model: model, base: isolated, duty: review, permissions: {read: [], write: [], execute: []}}\nnodes:\n",
			)
			.replace(
				"---\n## role",
				"communications:\n  - {from: researcher, to: reviewer, when: '#task', max_rounds: 2}\n---\n## role",
			),
	);
	prepared.members.reviewer = structuredClone(prepared.members.researcher);
	prepared.observation!.members.reviewer = {
		bot: { source_id: "review-source", profile_id: "profile", bot_id: "review-bot" },
		config_revision: "1",
		model_binding_ref: ref("review-model"),
	};
	const started = store.start(request, prepared);
	expect(started.state).toBe("accepted");
	const runId = started.target_id!;
	const owner = store.claimHost()!;
	store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	store.observeDispatch(owner.owner_id, owner.epoch, intent.id, "accepted", {
		job_id: "research-job",
		bot_id: "bot-id",
	});
	const service = store.configureConsultation({
		validate: (_db, identity) => identity.run_id === runId && identity.fence === owner.epoch,
		policy: () => ({ max_rounds: 2, timeout_ms: 60000 }),
		artifacts: () => true,
		reserve: () => true,
		participant: () => true,
	});
	const requester = {
		run_id: runId,
		member_id: "researcher",
		invocation_id: intent.invocation_id,
		attempt_id: intent.attempt_id,
		fence: owner.epoch,
	};
	const input = { to_member: "reviewer", text: "private-plan-text", request_key: "ask" };
	const before = ledger.snapshot("graph-source", runId);
	db.exec(
		"CREATE TRIGGER reject_consult_wire BEFORE INSERT ON graph_wire_events BEGIN SELECT RAISE(ABORT,'consult wire unavailable'); END",
	);
	expect(() => service.ask(requester, input)).toThrow("consult wire unavailable");
	expect(service.list(runId)).toEqual([]);
	expect(ledger.snapshot("graph-source", runId)).toEqual(before);
	db.exec("DROP TRIGGER reject_consult_wire");
	const asked = service.ask(requester, input);
	if (!asked.ok) throw new Error(asked.error);
	const initial = ledger.snapshot("graph-source", runId);
	expect(service.ask(requester, input)).toEqual(asked);
	expect(ledger.snapshot("graph-source", runId).cursor).toEqual(initial.cursor);
	const { conversation_id, message_id } = asked.value;
	expect(store.waitForConsultation(owner.owner_id, owner.epoch, requester, conversation_id, message_id)).toBe(true);
	const auxiliary = store.startConsultationInvocation(
		owner.owner_id,
		owner.epoch,
		runId,
		"reviewer",
		conversation_id,
		message_id,
	);
	if (!auxiliary) throw new Error("Missing consultation execution");
	const responder = {
		...requester,
		member_id: "reviewer",
		invocation_id: auxiliary.invocation_id,
		attempt_id: auxiliary.attempt_id,
	};
	service.activate(conversation_id);
	const question = service.question(responder, {
		conversation_id,
		reply_to: message_id,
		text: "private-question",
		request_key: "question",
	});
	if (!question.ok) throw new Error(question.error);
	expect(
		service.reply(requester, {
			conversation_id,
			reply_to: question.value.message_id,
			text: "private-evidence",
			request_key: "reply",
		}).ok,
	).toBe(true);
	expect(service.finish(responder, { conversation_id, text: "private-verdict", request_key: "finish" }).ok).toBe(true);
	const records = ledger.snapshot("graph-source", runId).records;
	expect(records.find(record => record.kind === "execution_conversation")).toMatchObject({
		value: {
			state: "answered",
			remaining_rounds: 1,
			message_refs: service.messages(conversation_id).map(message => message.content_ref.id),
		},
	});
	expect(JSON.stringify(records)).not.toContain("private-");
	expect(
		records.filter(record => record.kind === "execution_invocation").map(record => record.value.invocation_id),
	).not.toContain(auxiliary.invocation_id);
	expect(
		records.filter(record => record.kind === "execution_attempt").map(record => record.value.attempt_id),
	).not.toContain(auxiliary.attempt_id);
	expect(
		ledger
			.stateAt("graph-source", runId, initial.cursor)
			.records.find(record => record.kind === "execution_conversation"),
	).toMatchObject({
		value: { state: "queued", remaining_rounds: 2 },
	});
});

it("keeps legacy topology-only history unavailable for execution instead of manufacturing a baseline", () => {
	const { store, db, ledger, request, prepared } = fixture();
	const started = store.start(request, prepared);
	const runId = started.target_id!;
	const topology = ledger.snapshot("graph-source", runId).records.filter(record => record.kind === "run");
	// Restore a database written by the topology-only producer, including its original event.
	db.transaction(() => {
		db.query("DELETE FROM graph_wire_current WHERE source_id=? AND run_id=? AND kind!='run'").run(
			"graph-source",
			runId,
		);
		db.query("UPDATE graph_wire_events SET data=? WHERE source_id=? AND seq='1'").run(
			JSON.stringify(topology),
			"graph-source",
		);
	}).immediate();
	const before = ledger.snapshot("graph-source", runId);
	const owner = store.claimHost()!;
	expect(store.schedule(runId, owner.owner_id, owner.epoch).action?.type).toBe("ready");
	expect(store.getScheduleState(runId)?.invocations[0].state).toBe("ready");
	expect(ledger.snapshot("graph-source", runId)).toEqual(before);
	expect(ledger.stateAt("graph-source", runId, before.cursor).records).toEqual(topology);
});

function handoffFixture(
	options: { sourceBot?: boolean; targetBot?: boolean; loop?: boolean; unselected?: "outcome" | "any" } = {},
) {
	const sourceBot = options.sourceBot !== false;
	const targetBot = options.targetBot !== false;
	const base = fixture(content =>
		content
			.replace(
				"research: {kind: bot, member: researcher, task: '#task'}",
				`research: {kind: ${sourceBot ? "bot, member: researcher" : "program, executor: source-program"}, task: '#task', ${options.unselected ? "outcomes: [done, changed], " : ""}outputs: {plan: {media_type: text/plain, required: true}}}`,
			)
			.replace(
				"approval: {kind: human, task: '#task'}",
				`approval: {kind: ${targetBot ? "bot, member: researcher" : "human"}, task: '#task', ${options.unselected ? "join: any, " : ""}required_inputs: [plan]}`,
			)
			.replace(
				"{id: handoff, from: research, to: approval}",
				`{id: handoff, from: research, to: approval, bind: {plan: plan}${options.unselected === "outcome" ? ", branch_group: selection" : ""}}${options.unselected ? `\n  - {id: unselected, from: research, to: approval, on: [${options.unselected === "outcome" ? "changed" : "done"}]${options.unselected === "outcome" ? ", bind: {plan: plan}, branch_group: selection" : ""}}` : ""}`,
			)
			.replace(
				"edges:\n",
				options.loop
					? "  final: {kind: human, task: '#task', outcomes: [go, hold]}\nloops:\n  revision: {max_reviews: 3, final_node: final, retry_target: research, final_outcomes: {go: go, hold: hold}, count_nodes: [approval], scope: stage, stage: draft}\nedges:\n  - {id: back, from: approval, to: research, loop: revision}\n"
					: "edges:\n",
			),
	);
	const bots = new BotStore(path.join(base.root, "bots"));
	cleanups.push(() => bots.close());
	const bot = bots.createBot({ bot_name: "handoff", cwd: base.root });
	base.prepared.observation!.members.researcher.bot = {
		source_id: "research-source",
		profile_id: bots.profile_id,
		bot_id: bot.bot_id,
	};
	base.prepared.observation!.members.researcher.config_revision = bot.config_revision;
	if (!sourceBot) base.prepared.executors["source-program"] = ref("source-program");
	const started = base.store.start(base.request, base.prepared);
	expect(started.state).toBe("accepted");
	const runId = started.target_id!;
	const owner = base.store.claimHost()!;
	const registry = base.store.configureArtifacts({ maxBytes: 4096, authorize: async () => true });
	const worker = new BotWorker(bots, bot.bot_id, undefined, { scoped: true });
	expect(worker.claim()).toBe(true);
	const nextIntent = () => {
		for (let count = 0; count < 10; count++) {
			const scheduled = base.store.schedule(runId, owner.owner_id, owner.epoch);
			if (scheduled.intent) return scheduled.intent;
		}
		throw new Error("Expected dispatchable Graph invocation");
	};
	const admit = (intent: GraphDispatchIntent, input: string, key = intent.request_key) => {
		const target = base.store.getScheduleState(runId)!.invocations.find(item => item.id === intent.invocation_id)!;
		const attempt =
			base.store
				.getDispatchIntents(runId)
				.filter(item => item.invocation_id === target.id)
				.findIndex(item => item.id === intent.id) + 1;
		return worker.admitGraph({
			command: "submit",
			key,
			input,
			graph_context: {
				graph_id: base.prepared.graph_id,
				graph_run_id: runId,
				invocation_id: target.id,
				node_id: target.node,
				attempt,
				upstream: [],
			},
		});
	};
	const completeSource = async (source: GraphDispatchIntent, text = "plan-one") => {
		expect(base.store.claimDispatch(owner.owner_id, owner.epoch, source.id)).not.toBeNull();
		const receipt = sourceBot ? admit(source, "Produce plan") : null;
		base.store.observeDispatch(owner.owner_id, owner.epoch, source.id, "accepted", {
			job_id: receipt?.job_id ?? "not-a-bot-job",
			bot_id: bot.bot_id,
		});
		const beforePublication = base.ledger
			.snapshot("graph-source", runId)
			.records.filter(record => record.kind === "transfer");
		const artifact = await registry.store.publish("test", Buffer.from(text), {
			media_type: "text/plain",
			producer_attempt_id: source.attempt_id,
			source_ref: null,
			access_scope: ["test"],
		});
		expect(base.ledger.snapshot("graph-source", runId).records.filter(record => record.kind === "transfer")).toEqual(
			beforePublication,
		);
		const prepared = await registry.prepareRegistration([
			{
				artifact,
				expected: {
					media_type: "text/plain",
					producer_attempt_id: source.attempt_id,
					source_ref: null,
					access_scope: ["test"],
				},
			},
		]);
		const reference = { id: artifact.id, digest: artifact.digest };
		expect(
			base.store.completeAttempt(
				owner.owner_id,
				owner.epoch,
				{
					run_id: runId,
					invocation_id: source.invocation_id,
					attempt_id: source.attempt_id,
					fence: source.fence,
					state: "succeeded",
					outcome: "done",
					outputs: { plan: reference },
				},
				prepared,
			),
		).toBe(true);
		return { reference, receipt };
	};
	return { ...base, bots, bot, owner, worker, runId, nextIntent, admit, completeSource };
}

it("confirms only the exact durably admitted Bot handoff, atomically and without duplicate observation", async () => {
	const f = handoffFixture();
	try {
		const source = f.nextIntent();
		const { reference, receipt: sourceReceipt } = await f.completeSource(source);
		const target = f.nextIntent();
		expect(f.ledger.snapshot("graph-source", f.runId).records.filter(record => record.kind === "transfer")).toEqual(
			[],
		);
		expect(
			f.ledger.snapshot("graph-source", f.runId).records.find(record => record.kind === "dependency"),
		).toMatchObject({ value: { state: "satisfied" } });
		f.store.claimDispatch(f.owner.owner_id, f.owner.epoch, target.id);
		const envelope = f.store.prepareBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, "Review");
		expect(envelope).toContain(reference.digest);
		expect(envelope).toContain(source.attempt_id);
		const receipt = f.admit(target, envelope);
		const observation = { job_id: receipt.job_id, bot_id: f.bot.bot_id };
		f.db.exec(
			"CREATE TRIGGER reject_handoff_wire BEFORE INSERT ON graph_wire_events BEGIN SELECT RAISE(ABORT,'handoff wire unavailable'); END",
		);
		expect(() =>
			f.store.confirmBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, f.bots, receipt.job_id!, observation),
		).toThrow("handoff wire unavailable");
		expect(f.store.getDispatchIntents(f.runId).find(intent => intent.id === target.id)?.state).toBe("submitting");
		expect(f.ledger.snapshot("graph-source", f.runId).records.filter(record => record.kind === "transfer")).toEqual(
			[],
		);
		f.db.exec("DROP TRIGGER reject_handoff_wire");
		expect(
			f.store.confirmBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, f.bots, receipt.job_id!, observation),
		).toBe(true);
		const confirmed = f.ledger.snapshot("graph-source", f.runId);
		const transfers = confirmed.records.filter(record => record.kind === "transfer");
		expect(transfers).toHaveLength(1);
		expect(transfers[0]).toMatchObject({
			value: {
				from_binding_id: source.attempt_id,
				to_binding_id: target.attempt_id,
				state: "delivered",
				artifact: { artifact_id: reference.id, ref: reference.id, job_id: sourceReceipt!.job_id },
			},
		});
		expect(f.bots.getJob(f.bot.bot_id, receipt.job_id!).inputs[0].input).toBe(envelope);
		expect(
			f.store.confirmBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, f.bots, receipt.job_id!, observation),
		).toBe(true);
		f.store.observeDispatch(f.owner.owner_id, f.owner.epoch, target.id, "accepted", observation);
		expect(f.ledger.snapshot("graph-source", f.runId).cursor).toEqual(confirmed.cursor);
	} finally {
		await f.worker.close();
	}
});

for (const mismatch of ["fence", "target", "artifact", "unadmitted"] as const)
	it(`does not confirm a handoff with ${mismatch} evidence`, async () => {
		const f = handoffFixture();
		try {
			await f.completeSource(f.nextIntent());
			const target = f.nextIntent();
			f.store.claimDispatch(f.owner.owner_id, f.owner.epoch, target.id);
			const envelope = f.store.prepareBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, "Review");
			const receipt =
				mismatch === "unadmitted"
					? null
					: f.admit(target, mismatch === "artifact" ? envelope.replace(/sha256:/g, "wrong-digest:") : envelope);
			const confirm = () =>
				f.store.confirmBotHandoff(
					f.owner.owner_id,
					mismatch === "fence" ? "0" : f.owner.epoch,
					target.id,
					f.bots,
					mismatch === "target" || !receipt ? "wrong-job" : receipt.job_id!,
					{},
				);
			if (mismatch === "fence") expect(confirm).toThrow();
			else expect(confirm()).toBe(false);
			expect(
				f.ledger.snapshot("graph-source", f.runId).records.filter(record => record.kind === "transfer"),
			).toEqual([]);
			if (receipt && mismatch !== "fence") {
				f.store.observeDispatch(f.owner.owner_id, f.owner.epoch, target.id, "accepted", {
					job_id: receipt.job_id,
					bot_id: f.bot.bot_id,
				});
				expect(
					f.ledger.snapshot("graph-source", f.runId).records.filter(record => record.kind === "transfer"),
				).toMatchObject([{ value: { state: "unknown", reason: "mailbox_admission_unconfirmed" } }]);
			}
		} finally {
			await f.worker.close();
		}
	});

for (const nonBot of ["source", "target"] as const)
	it(`never fabricates Bot bindings or transfers for a non-Bot ${nonBot}`, async () => {
		const f = handoffFixture({ sourceBot: nonBot !== "source", targetBot: nonBot !== "target" });
		try {
			const source = f.nextIntent();
			await f.completeSource(source);
			const target = f.nextIntent();
			f.store.claimDispatch(f.owner.owner_id, f.owner.epoch, target.id);
			expect(f.store.prepareBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, "Review")).toBe("Review");
			f.store.observeDispatch(f.owner.owner_id, f.owner.epoch, target.id, "accepted", {
				job_id: "not-a-bot-job",
				bot_id: f.bot.bot_id,
			});
			const records = f.ledger.snapshot("graph-source", f.runId).records;
			expect(records.filter(record => record.kind === "transfer")).toEqual([]);
			const excluded = nonBot === "source" ? source : target;
			expect(
				records.some(record => record.kind === "binding" && record.value.binding_id === excluded.attempt_id),
			).toBe(false);
		} finally {
			await f.worker.close();
		}
	});

it("retains the original delivered source and target attempt across a bounded retry", async () => {
	const f = handoffFixture({ loop: true });
	try {
		const source = f.nextIntent();
		const first = await f.completeSource(source);
		const target = f.nextIntent();
		f.store.claimDispatch(f.owner.owner_id, f.owner.epoch, target.id);
		const envelope = f.store.prepareBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, "Review");
		const receipt = f.admit(target, envelope);
		expect(f.store.confirmBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, f.bots, receipt.job_id!, {})).toBe(
			true,
		);
		const original = f.ledger.snapshot("graph-source", f.runId);
		const delivered = original.records.filter(record => record.kind === "transfer");
		expect(
			f.store.completeAttempt(f.owner.owner_id, f.owner.epoch, {
				run_id: f.runId,
				invocation_id: target.invocation_id,
				attempt_id: target.attempt_id,
				fence: target.fence,
				state: "succeeded",
				outcome: "done",
			}),
		).toBe(true);
		expect(f.store.schedule(f.runId, f.owner.owner_id, f.owner.epoch).action?.type).toBe("rewind");
		const retriedSource = f.nextIntent();
		const second = await f.completeSource(retriedSource, "plan-two");
		const retriedTarget = f.nextIntent();
		f.store.claimDispatch(f.owner.owner_id, f.owner.epoch, retriedTarget.id);
		const retriedEnvelope = f.store.prepareBotHandoff(
			f.owner.owner_id,
			f.owner.epoch,
			retriedTarget.id,
			"Review again",
		);
		expect(retriedEnvelope).toContain(second.reference.digest);
		expect(retriedEnvelope).not.toContain(first.reference.digest);
		const retriedReceipt = f.admit(retriedTarget, retriedEnvelope);
		expect(
			f.store.confirmBotHandoff(
				f.owner.owner_id,
				f.owner.epoch,
				retriedTarget.id,
				f.bots,
				retriedReceipt.job_id!,
				{},
			),
		).toBe(true);
		const current = f.ledger.snapshot("graph-source", f.runId);
		expect(current.records.filter(record => record.kind === "transfer")).toHaveLength(2);
		expect(current.records.filter(record => record.kind === "transfer")).toEqual(expect.arrayContaining(delivered));
		expect(
			current.records.filter(record => record.kind === "binding").map(record => record.value.binding_id),
		).toEqual(
			expect.arrayContaining([
				source.attempt_id,
				target.attempt_id,
				retriedSource.attempt_id,
				retriedTarget.attempt_id,
			]),
		);
		expect(
			f.ledger
				.stateAt("graph-source", f.runId, original.cursor)
				.records.filter(record => record.kind === "transfer"),
		).toEqual(delivered);
	} finally {
		await f.worker.close();
	}
});

it("admits a real BotStore handoff through GraphHost without starting a runtime or model request", async () => {
	const f = handoffFixture();
	let host: GraphHost | undefined;
	let runtimes = 0;
	try {
		const source = f.nextIntent();
		const { reference } = await f.completeSource(source);
		await f.worker.close();
		host = new GraphHost({
			store: f.store,
			program: {
				accept: async () => {
					throw new Error("Unexpected program execution");
				},
				query: () => null,
				cancel: () => "unknown",
			},
			resolveProgram: async () => {
				throw new Error("Unexpected program resolution");
			},
			verifyProgramResult: async () => {
				throw new Error("Unexpected program result");
			},
			bot: {
				store: f.bots,
				authorize: () => true,
				resolve: async intent => ({
					job: {
						job_id: "template",
						bot_id: f.bot.bot_id,
						config_revision: f.bot.config_revision,
						graph_context: {
							graph_id: f.prepared.graph_id,
							graph_run_id: f.runId,
							invocation_id: intent.invocation_id,
							node_id: "approval",
							attempt: 1,
							upstream: [],
						},
					} as never,
					member_id: "researcher",
					input: "Review",
					callbacks: { onEvent() {} },
					assignment: {
						member: f.store.getFrozenDefinition(f.runId)!.members.researcher,
						role: "Research",
						task: "Work",
						bindings: [{ name: "model", provider: "provider", model: "model", revision: "7" }],
						modelRegistry: {
							getAvailableForProviders: () => [{ provider: "provider", id: "model" }],
							hasConfiguredAuth: () => true,
						} as never,
						baseAvailable: true,
						assertToolCall() {},
					},
				}),
				createRuntime: async () => {
					runtimes++;
					throw new Error("Admission smoke MUST NOT start a runtime");
				},
			},
		});
		expect(host.start()).toBe(true);
		await host.tick(); // Route the completed source.
		await host.tick(); // Freeze selected target inputs.
		await host.tick(); // Admit the target mailbox; do not pump it.
		expect(runtimes).toBe(0);
		const transfers = f.ledger.snapshot("graph-source", f.runId).records.filter(record => record.kind === "transfer");
		expect(transfers).toHaveLength(1);
		expect(transfers[0]).toMatchObject({ value: { state: "delivered", artifact: { artifact_id: reference.id } } });
		const target = f.store.getDispatchIntents(f.runId).find(intent => intent.id !== source.id)!;
		const admitted = f.bots.graphHostedByKey(f.bot.bot_id, target.request_key)!;
		expect(admitted.job.inputs[0].input).toContain(reference.digest);
		expect(admitted.job.inputs[0].input).toContain(source.attempt_id);
		expect(admitted.job.state).toBe("queued");
		expect(admitted.job.execution_id).toBeNull();
	} finally {
		await host?.shutdown();
		await f.worker.close();
	}
});

for (const selection of ["outcome", "any"] as const)
	it(`does not satisfy or transfer an unselected ${selection} edge from the same upstream invocation`, async () => {
		const f = handoffFixture({ unselected: selection });
		try {
			await f.completeSource(f.nextIntent());
			const target = f.nextIntent();
			f.store.claimDispatch(f.owner.owner_id, f.owner.epoch, target.id);
			const envelope = f.store.prepareBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, "Review");
			const receipt = f.admit(target, envelope);
			expect(
				f.store.confirmBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, f.bots, receipt.job_id!, {}),
			).toBe(true);
			const transfers = f.ledger
				.snapshot("graph-source", f.runId)
				.records.filter(record => record.kind === "transfer");
			expect(transfers).toHaveLength(1);
			expect(transfers[0]).toMatchObject({ value: { edge_id: "handoff", state: "delivered" } });
			const dependencies = f.ledger
				.snapshot("graph-source", f.runId)
				.records.filter(record => record.kind === "dependency");
			expect(dependencies.find(record => record.value.edge_id === "handoff")).toMatchObject({
				value: { state: "satisfied" },
			});
			expect(dependencies.find(record => record.value.edge_id === "unselected")).toMatchObject({
				value: { state: "rejected", reason: "not_selected", evidence: [] },
			});
			expect(envelope).not.toContain("unselected");
		} finally {
			await f.worker.close();
		}
	});

it("does not retrofit handoff evidence into a topology-only legacy Run", async () => {
	const f = handoffFixture();
	try {
		await f.completeSource(f.nextIntent());
		const target = f.nextIntent();
		f.store.claimDispatch(f.owner.owner_id, f.owner.epoch, target.id);
		f.db
			.query("DELETE FROM graph_wire_current WHERE source_id=? AND run_id=? AND kind!='run'")
			.run("graph-source", f.runId);
		expect(f.store.prepareBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, "Review")).toBe("Review");
		const receipt = f.admit(target, "Review");
		expect(
			f.store.confirmBotHandoff(f.owner.owner_id, f.owner.epoch, target.id, f.bots, receipt.job_id!, {
				job_id: receipt.job_id,
				bot_id: f.bot.bot_id,
			}),
		).toBe(true);
		expect(f.ledger.snapshot("graph-source", f.runId).records.map(record => record.kind)).toEqual(["run"]);
		expect(f.db.query("SELECT intent_id FROM graph_bot_handoffs").all()).toEqual([]);
	} finally {
		await f.worker.close();
	}
});

function observedQueueFixture() {
	const f = fixture(content => content.replace("kind: bot, member: researcher", "kind: queue, executor: video"));
	f.prepared.executors.video = ref("video");
	const runId = f.store.start(f.request, f.prepared).target_id!;
	const owner = f.store.claimHost()!;
	f.store.schedule(runId, owner.owner_id, owner.epoch);
	const intent = f.store.schedule(runId, owner.owner_id, owner.epoch).intent!;
	f.store.claimDispatch(owner.owner_id, owner.epoch, intent.id);
	const request: QueueExecutionRequest = {
		version: 1,
		run_id: runId,
		invocation_id: intent.invocation_id,
		attempt_id: intent.attempt_id,
		fence: intent.fence,
		request_key: intent.request_key,
		executor: "video",
		inputs: {},
		task_ref: ref("task"),
		authorization_ref: ref("authorization"),
		model_binding_ref: null,
		base_snapshot_ref: null,
		duty: "general",
		deadline: null,
	};
	const observation: QueueObservation = {
		service_id: "video-service",
		attempt_id: intent.attempt_id,
		fence: intent.fence,
		request_key: intent.request_key,
		external_task_id: "private-remote-task",
		state: "accepted",
		result_refs: [],
		observed_at: "2026-11-06T00:00:00.000Z",
	};
	const adapter = new QueueAdapter(
		{
			service_id: observation.service_id,
			capabilities: { submit_idempotent: true, lookup_by_key: true, cancel: false },
			async submit() {
				return observation;
			},
			async query() {
				return { status: "unknown" };
			},
			async cancel() {
				throw new Error("Cancellation unavailable");
			},
		},
		f.store,
	);
	return { ...f, runId, owner, intent, request, observation, adapter };
}

it("publishes durable queue progress without treating a remote result as verified dependency success", async () => {
	const f = observedQueueFixture();
	await f.adapter.submit(f.request);
	f.store.observeDispatch(f.owner.owner_id, f.owner.epoch, f.intent.id, "accepted", {
		service_id: f.observation.service_id,
		request_key: f.intent.request_key,
	});
	const current = () => f.ledger.snapshot("graph-source", f.runId);
	const work = () =>
		current().records.find(record => record.kind === "execution_invocation" && record.value.node_id === "research");
	expect(work()).toMatchObject({ value: { state: "waiting", wait_reason: "queue:accepted" } });
	const queued = { ...f.observation, state: "queued" as const };
	await f.adapter.observe(queued, f.observation);
	expect(work()).toMatchObject({ value: { state: "waiting", wait_reason: "queue:queued" } });
	const queuedImage = current();
	await f.adapter.observe(queued, f.observation);
	await f.adapter.get(f.intent.request_key);
	expect(current().cursor).toEqual(queuedImage.cursor);
	await f.adapter.observe({ ...f.observation, state: "running" }, f.observation);
	expect(work()).toMatchObject({ value: { state: "waiting", wait_reason: "queue:running" } });
	expect(
		f.ledger
			.stateAt("graph-source", f.runId, queuedImage.cursor)
			.records.find(record => record.kind === "execution_invocation" && record.value.node_id === "research"),
	).toMatchObject({ value: { wait_reason: "queue:queued" } });
	await f.adapter.observe({ ...f.observation, state: "succeeded" }, f.observation);
	expect(work()).toMatchObject({ value: { state: "waiting", wait_reason: "queue:succeeded" } });
	expect(f.store.getScheduleState(f.runId)?.invocations.find(item => item.node === "approval")?.state).toBe("pending");
	expect(f.store.getAttemptHistory(f.runId)).toEqual([]);
	expect(JSON.stringify(current().records)).not.toContain("private-remote-task");
	expect(current().records.some(record => record.kind === "binding" || record.kind === "transfer")).toBe(false);
	expect(
		f.store.completeAttempt(f.owner.owner_id, f.owner.epoch, {
			run_id: f.runId,
			invocation_id: f.intent.invocation_id,
			attempt_id: f.intent.attempt_id,
			fence: f.intent.fence,
			state: "succeeded",
			outcome: "done",
			outputs: {},
		}),
	).toBe(true);
	expect(work()).toMatchObject({ value: { state: "succeeded", wait_reason: null } });
	f.store.schedule(f.runId, f.owner.owner_id, f.owner.epoch);
	f.store.schedule(f.runId, f.owner.owner_id, f.owner.epoch);
	expect(f.store.getScheduleState(f.runId)?.invocations.find(item => item.node === "approval")?.state).toBe("ready");
});

it("rolls back queue progress with failed wire publication and exposes unresolved reconciliation without completing it", async () => {
	const f = observedQueueFixture();
	await f.adapter.submit(f.request);
	const before = f.ledger.snapshot("graph-source", f.runId);
	f.db.exec(
		"CREATE TRIGGER reject_queue_wire BEFORE INSERT ON graph_wire_events BEGIN SELECT RAISE(ABORT,'queue wire blocked'); END",
	);
	await expect(f.adapter.observe({ ...f.observation, state: "queued" }, f.observation)).rejects.toThrow(
		"queue wire blocked",
	);
	expect(await f.adapter.get(f.intent.request_key)).toMatchObject({ state: "accepted" });
	expect(f.ledger.snapshot("graph-source", f.runId)).toEqual(before);
	f.db.exec("DROP TRIGGER reject_queue_wire");
	await f.adapter.reconcile(f.intent.request_key);
	const unresolved = f.ledger.snapshot("graph-source", f.runId);
	expect(
		unresolved.records.find(record => record.kind === "execution_invocation" && record.value.node_id === "research"),
	).toMatchObject({ value: { state: "waiting", wait_reason: "queue:unknown" } });
	expect(f.store.getAttemptHistory(f.runId)).toEqual([]);
	await f.adapter.reconcile(f.intent.request_key);
	expect(f.ledger.snapshot("graph-source", f.runId).cursor).toEqual(unresolved.cursor);
});
