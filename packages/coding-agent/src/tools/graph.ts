import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { DAILY_CODE_WORKFLOW } from "../bots/daily-code-input";
import { answerGraphRun, type GraphAnswerPolicy } from "../graph/answer";
import {
	GraphAuthoringService,
	type GraphError,
	type GraphExecutionReceiptAuthorizer,
	type GraphOperation,
} from "../graph/authoring";
import { GRAPH_CLI_LIMITS } from "../graph/cli";
import type { GraphDispatchPolicy } from "../graph/dispatch";
import { buildGraphCatalog } from "../graph/catalog";
import type { GraphCursor, GraphNotification, GraphRef } from "@oh-my-pi/pi-wire/graph";
import type { GraphArtifact } from "../graph/artifacts";
import { buildRunIndex, GraphObservation, isTerminalRunState, summarizeNodeProgress } from "../graph/observation";
import { buildGraphReport, renderGraphReportText } from "../graph/report";
import { GraphRunStore, type GraphLifecyclePolicy, type GraphLifecycleRequest } from "../graph/store";
import { listGraphTemplates, readGraphTemplate } from "../graph/templates";
import { startGraphRun, type GraphStartPolicy } from "../graph/start";
import type { GraphTextPublicationPolicy } from "../graph/text-publication";
import manageDescription from "../prompts/tools/graph-manage.md" with { type: "text" };
import readDescription from "../prompts/tools/graph-read.md" with { type: "text" };

const manageSchema = type({
	version: "1",
	request_key: "string",
	operation: "'create' | 'import' | 'edit' | 'member.add' | 'node.add' | 'connect' | 'permit'",
	target_id: "string | null",
	if_revision: "string | null",
	payload: { "[string]": "unknown" },
})
	.or({
		version: "1",
		request_key: "string",
		operation: "'hold'",
		target_id: "string",
		if_revision: "string",
		payload: { reason: "string", "kind?": "'operator' | 'gate'" },
	})
	.or({
		version: "1",
		request_key: "string",
		operation: "'cancel'",
		target_id: "string",
		if_revision: "string",
		payload: { reason: "string" },
	})
	.or({
		version: "1",
		request_key: "string",
		operation: "'resume'",
		target_id: "string",
		if_revision: "string",
		payload: { decision_ref: { id: "string", digest: "string" } },
	})
	.or({
		version: "1",
		request_key: "string",
		operation: "'resume'",
		target_id: "string",
		if_revision: "string",
		payload: { kind: "'operator'" },
	})
	.or({
		version: "1",
		request_key: "string",
		operation: "'start'",
		target_id: "string",
		if_revision: "string",
		payload: {
			inputs: { "[string]": { id: "string", digest: "string" } },
			authorization_ref: { id: "string", digest: "string" },
			"entry_nodes?": "string[]",
			"provided_outputs?": { "[string]": { "[string]": { id: "string", digest: "string" } } },
		},
	})
	.or({
		version: "1",
		request_key: "string",
		operation: "'answer'",
		target_id: "string",
		if_revision: "string",
		payload: {
			decision_id: "string",
			input_digest: "string",
			outcome: "string",
			content_ref: { id: "string", digest: "string" },
			"verdict?": "string",
			"evidence_refs?": type({ id: "string", digest: "string" }).array(),
		},
	})
	.or({
		version: "1",
		request_key: "string",
		operation: "'dispatch'",
		target_id: "string",
		if_revision: "null",
		payload: {
			title: "string",
			bindings: "string",
			inputs: { "[string]": "string" },
			"max_model_calls?": "number",
			"timeout_ms?": "number",
			"report_to?": "string",
		},
	})
	.or({
		version: "1",
		request_key: "string",
		operation: "'artifact.publish'",
		target_id: "string",
		if_revision: "null",
		payload: {
			content: "string",
			media_type: "string",
			expected_digest: "string | null",
		},
	});

const readSchema = type({
	version: "1",
	operation:
		"'definition.get' | 'request.get' | 'status' | 'events' | 'catalog' | 'templates' | 'workflows' | 'runs' | 'report' | 'notifications' | 'wait'",
	"target_id?": "string",
	"revision?": "string",
	"after?": { journal_id: "string", seq: "string" },
	"limit?": "number",
	"since?": "number",
	"run_id?": "string",
	/** `wait` only: bounded ceiling for one blocking observation. */
	"timeout_ms?": "number",
});

export type GraphManageParams = typeof manageSchema.infer;
export type GraphReadParams = typeof readSchema.infer;

/** The run authorizer is supplied by a trusted host, never by a tool call. */
export interface GraphToolOptions {
	root?: string;
	/** Override bundled template discovery; the agent passes none in production. */
	templateRoot?: string;
	authorizeRun?: (runId: string) => boolean | Promise<boolean>;
	authorizeExecutionReceipt?: GraphExecutionReceiptAuthorizer;
	/** Independent authenticated control permission; neither read gate grants lifecycle authority. */
	lifecycle?: { principal: string; policy: GraphLifecyclePolicy };
	/** Explicit start admission; model-supplied references are not grants. */
	start?: GraphStartPolicy;
	/** Current human identity, decision policy and authorized immutable content resolution. */
	answer?: GraphAnswerPolicy;
	/** Separate bounded text publication permission; grants no execution or human approval. */
	publication?: GraphTextPublicationPolicy;
	/** Background dispatch authority; the policy owns the ceiling and the child process. */
	dispatch?: GraphDispatchPolicy;
	/** Trusted artifact read for `report`; a ref is never a grant, so the host authorizes content. */
	readArtifact?: (ref: GraphRef) => Promise<{ artifact: GraphArtifact; bytes: Uint8Array }>;
}

function graphError(code: string, message: string, details: Record<string, unknown> | null = null): GraphError {
	return { code, message, location: null, retryable: false, details };
}

function fromError(error: unknown): GraphError {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		"message" in error &&
		typeof error.message === "string"
	) {
		const details =
			"details" in error && error.details && typeof error.details === "object"
				? (error.details as Record<string, unknown>)
				: null;
		return graphError(error.code, error.message, details);
	}
	return graphError("internal_error", "Graph service failed");
}

export class GraphManageTool implements AgentTool<typeof manageSchema> {
	readonly name = "graph_manage";
	readonly approval = "write" as const;
	readonly label = "Graph Manage";
	readonly description = manageDescription;
	readonly parameters = manageSchema;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Author Graphs, publish text, and operate explicitly authorized Runs";

	constructor(private readonly options: GraphToolOptions = {}) {}

	async execute(_id: string, request: GraphManageParams): Promise<AgentToolResult> {
		let store: GraphAuthoringService | undefined;
		let runs: GraphRunStore | undefined;
		try {
			if (request.operation === "dispatch") {
				const admission = this.options.dispatch;
				if (!admission) throw graphError("capability_unavailable", "Graph dispatch requires a trusted policy");
				const dispatched = await admission.dispatch({
					request_key: request.request_key,
					graph_id: request.target_id,
					title: request.payload.title,
					bindings: request.payload.bindings,
					inputs: request.payload.inputs,
					max_model_calls: request.payload.max_model_calls ?? admission.maxModelCalls,
					timeout_ms: request.payload.timeout_ms ?? admission.maxTimeoutMs,
					...(request.payload.report_to ? { report_to: request.payload.report_to } : {}),
				});
				const text = [
					`Request: ${dispatched.request_key}`,
					"State: accepted",
					`Run: ${dispatched.run_id}`,
					`Log: ${dispatched.log_path}`,
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: {
						version: 1 as const,
						operation: "dispatch" as const,
						request_key: dispatched.request_key,
						state: "accepted" as const,
						run_id: dispatched.run_id,
						log_path: dispatched.log_path,
					},
					isError: false,
				};
			}
			let result: GraphOperation;
			if (request.operation === "hold" || request.operation === "resume" || request.operation === "cancel") {
				const admission = this.options.lifecycle;
				if (!admission)
					throw graphError("capability_unavailable", "Graph lifecycle control requires a trusted policy");
				runs = new GraphRunStore(GRAPH_CLI_LIMITS, this.options.root);
				runs.configureLifecycle(admission.policy);
				// A tool-initiated pause is a scheduling pause the same principal may lift;
				// decision gates are explicit through `kind: "gate"`. Mirrors the CLI.
				const lifecycleRequest: GraphLifecycleRequest =
					request.operation === "hold" && request.payload.kind === undefined
						? { ...request, payload: { ...request.payload, kind: "operator" } }
						: request;
				result = runs.mutateLifecycle(admission.principal, lifecycleRequest);
			} else if (request.operation === "start") {
				const admission = this.options.start;
				if (!admission) throw graphError("capability_unavailable", "Graph start requires trusted admission");
				runs = new GraphRunStore(GRAPH_CLI_LIMITS, this.options.root);
				result = await startGraphRun(runs, admission, request);
			} else if (request.operation === "answer") {
				const admission = this.options.answer;
				if (!admission) throw graphError("capability_unavailable", "Graph answer requires trusted admission");
				runs = new GraphRunStore(GRAPH_CLI_LIMITS, this.options.root);
				runs.configureHuman(admission.authorize);
				result = await answerGraphRun(runs, admission, request);
			} else if (request.operation === "artifact.publish") {
				const admission = this.options.publication;
				if (!admission)
					throw graphError("capability_unavailable", "Graph artifact publication requires trusted admission");
				runs = new GraphRunStore(GRAPH_CLI_LIMITS, this.options.root);
				result = await runs.configureTextPublications(admission).publish(request);
			} else {
				store = new GraphAuthoringService(GRAPH_CLI_LIMITS, this.options.root);
				// A template name resolves to bundled content, so a dispatcher never has to know
				// a repository path; the resolved bytes are exactly what an importer would send.
				const template = request.operation === "import" ? request.payload.template : undefined;
				const mutation =
					typeof template === "string"
						? await (async () => {
								let resolved: Awaited<ReturnType<typeof readGraphTemplate>>;
								try {
									resolved = await readGraphTemplate(
										template,
										GRAPH_CLI_LIMITS,
										this.options.templateRoot ? { root: this.options.templateRoot } : {},
									);
								} catch (cause) {
									throw graphError(
										"unknown_reference",
										cause instanceof Error ? cause.message : "Unknown Graph template",
									);
								}
								return {
									...request,
									payload: { content: await Bun.file(resolved.path).text() },
								};
							})()
						: request;
				result = store.mutate(mutation);
			}
			const text = [
				`Request: ${result.request_key}`,
				`State: ${result.state}`,
				result.target_id
					? `${request.operation === "artifact.publish" ? "Target" : runs ? "Run" : "Graph"}: ${result.target_id}`
					: null,
				result.revision ? `Revision: ${result.revision}` : null,
				request.operation === "artifact.publish" && result.result_ref
					? `Artifact: ${result.result_ref.id}@${result.result_ref.digest}`
					: null,
				result.error ? `Reason: ${result.error.code}: ${result.error.message}` : null,
			]
				.filter(Boolean)
				.join("\n");
			return { content: [{ type: "text", text }], details: result, isError: result.error !== null };
		} catch (error) {
			const failure = fromError(error);
			const result = {
				request_key: request.request_key,
				state: "rejected",
				target_id: request.target_id,
				revision: null,
				result_ref: null,
				error: failure,
			};
			return {
				content: [{ type: "text", text: `Reason: ${failure.code}: ${failure.message}` }],
				details: result,
				isError: true,
			};
		} finally {
			store?.close();
			runs?.close();
		}
	}
}

export class GraphReadTool implements AgentTool<typeof readSchema> {
	readonly name = "graph_read";
	readonly approval = "read" as const;
	readonly label = "Graph Read";
	readonly description = readDescription;
	readonly parameters = readSchema;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Discover Graph templates and headless Bot workflows, or read authorized Run observations";

	constructor(private readonly options: GraphToolOptions = {}) {}

	async execute(_id: string, request: GraphReadParams): Promise<AgentToolResult> {
		let definitions: GraphAuthoringService | undefined;
		let observation: GraphObservation | undefined;
		let revision: string | null = null;
		let records: object[] = [];
		let next_cursor: GraphCursor | null = null;
		let notification_cursor: number | null = null;
		let content = "";
		let error: GraphError | null = null;
		try {
			const operation = request.operation;
			const catalog = operation === "catalog";
			const noTarget =
				catalog ||
				operation === "templates" ||
				operation === "workflows" ||
				operation === "runs" ||
				operation === "notifications";
			const limitValid =
				request.limit === undefined
					? true
					: operation === "events"
						? Number.isInteger(request.limit) && request.limit >= 1 && request.limit <= 100
						: operation === "notifications" || operation === "runs"
							? Number.isInteger(request.limit) && request.limit >= 1 && request.limit <= 200
							: false;
			const sinceValid =
				request.since === undefined
					? true
					: (operation === "notifications" || operation === "wait") &&
						Number.isInteger(request.since) &&
						request.since >= 0;
			// A wait is bounded: an unbounded block would hold a dispatcher turn open with no
			// way to observe or stop it from the calling side.
			const timeoutValid =
				request.timeout_ms === undefined
					? true
					: operation === "wait" &&
						Number.isInteger(request.timeout_ms) &&
						request.timeout_ms >= 1_000 &&
						request.timeout_ms <= 600_000;
			if (
				request.version !== 1 ||
				(noTarget ? request.target_id !== undefined : !request.target_id) ||
				(request.revision !== undefined && operation !== "definition.get") ||
				(request.after !== undefined && operation !== "events") ||
				!limitValid ||
				!sinceValid ||
				!timeoutValid ||
				(request.run_id !== undefined && operation !== "notifications")
			) {
				throw graphError("invalid_input", "Invalid Graph read parameters");
			}
			const target = request.target_id ?? "";
			if (operation === "workflows") {
				records = [DAILY_CODE_WORKFLOW];
				content = JSON.stringify(DAILY_CODE_WORKFLOW, null, 2);
			} else if (catalog) {
				definitions = new GraphAuthoringService(GRAPH_CLI_LIMITS, this.options.root);
				const entries = buildGraphCatalog(definitions.listDefinitions(), GRAPH_CLI_LIMITS);
				records = entries;
				content = entries.length
					? entries
							.map(
								entry =>
									`${entry.name} (${entry.graph_id}@${entry.revision})  contract:${entry.contract_source}${entry.duplicates ? `  identical imports:${entry.duplicates}` : ""}\nSummary: ${entry.summary ?? "not declared"}\nBindings: ${entry.bindings ?? "none declared"}\nInputs: ${entry.inputs.map(input => input.name).join(", ") || "none"}\nOutputs: ${entry.outputs.map(output => output.name).join(", ") || "none"}\nDeliverable: ${entry.deliverable ? `${entry.deliverable.artifacts.join(", ") || "none declared"}${entry.deliverable.summary ? ` — ${entry.deliverable.summary}` : ""}` : "not declared"}\nReport events: ${entry.report_events.join(", ") || "none"}\nLocal run: ${entry.local_run.supported ? "supported" : (entry.local_run.reason ?? "unsupported")}`,
							)
							.join("\n\n")
					: "No Graph definitions are available";
			} else if (operation === "templates") {
				const listing = await listGraphTemplates(
					GRAPH_CLI_LIMITS,
					this.options.templateRoot ? { root: this.options.templateRoot } : {},
				);
				records = listing.templates;
				content = listing.root
					? [
							`Templates: ${listing.templates.length}  from ${listing.root}`,
							...listing.templates.map(template => {
								const entry = template.entry;
								if (!entry || template.error)
									return `${template.template}  invalid: ${template.error ?? "contract unavailable"}`;
								return `${template.template}  in:${entry.inputs.map(input => input.name).join(",") || "-"}  out:${entry.outputs.map(output => output.name).join(",") || "-"}  bind:${entry.bindings ?? "-"}  local:${entry.local_run.supported ? "yes" : "no"}  deliver:${entry.deliverable?.artifacts.join(",") || "-"}  path:${template.path}${entry.summary ? `\n  ${entry.summary}` : ""}`;
							}),
						].join("\n")
					: "No bundled Graph templates are available";
				content += `\nHost workflow: daily-code (not a Graph template). Read operation workflows for its headless Bot command and contract.`;
			} else if (request.operation === "definition.get" || request.operation === "request.get") {
				definitions = new GraphAuthoringService(GRAPH_CLI_LIMITS, this.options.root);
				if (request.operation === "definition.get") {
					const snapshot = definitions.get(target, request.revision);
					if (!snapshot) throw graphError("unknown_graph", "Graph definition does not exist");
					revision = snapshot.revision;
					records = [{ graph_id: snapshot.graph_id, revision: snapshot.revision, digest: snapshot.digest }];
					content = snapshot.content;
				} else {
					const result = definitions.requestGetAuthorized(target, this.options.authorizeExecutionReceipt);
					if (!result) throw graphError("unknown_reference", "Request does not exist");
					revision = result.receipt.revision;
					records = [result.receipt];
					content = `Request: ${result.receipt.request_key}\nState: ${result.receipt.state}`;
				}
			} else if (operation === "runs") {
				if (!this.options.authorizeRun) throw graphError("permission_denied", "Run observation is not authorized");
				observation = new GraphObservation(this.options.root, GRAPH_CLI_LIMITS);
				const index = await buildRunIndex(observation, this.options.authorizeRun);
				const shown = request.limit === undefined ? index.runs : index.runs.slice(0, request.limit);
				records = shown;
				content = [
					`Runs: ${shown.length} of ${index.runs.length}  as of ${index.as_of}`,
					...shown.map(
						run =>
							`${run.run_id}  ${run.title ? `${run.title}  ` : ""}${run.graph_id}  ${run.state}${run.hold_kind ? `(${run.hold_kind})` : ""}${run.stalled ? "  STALLED" : ""}${summarizeNodeProgress(run.nodes) ? `  ${summarizeNodeProgress(run.nodes)}` : ""}${run.deliverable ? `  deliver:${run.deliverable.ready ? "ready" : `pending(${run.deliverable.missing.join(",")})`}` : ""}  ${run.last_event ?? "created"}  ${run.last_activity_at}${run.turn_count !== undefined ? `  turns:${run.turn_count}` : ""}`,
					),
				].join("\n");
			} else if (operation === "report") {
				const authorize = this.options.authorizeRun;
				const readArtifact = this.options.readArtifact;
				if (!authorize || !readArtifact)
					throw graphError("permission_denied", "Run report requires observation and artifact-read authorization");
				if ((await authorize(target)) !== true)
					throw graphError("permission_denied", "Run observation is not authorized");
				observation = new GraphObservation(this.options.root, GRAPH_CLI_LIMITS);
				const report = await buildGraphReport(observation, target, { readArtifact });
				revision = null;
				records = [report];
				content = renderGraphReportText(report);
			} else if (operation === "notifications") {
				const authorize = this.options.authorizeRun;
				if (!authorize) throw graphError("permission_denied", "Run observation is not authorized");
				observation = new GraphObservation(this.options.root, GRAPH_CLI_LIMITS);
				const read = observation.notifications({
					since: request.since ?? 0,
					limit: request.limit ?? 50,
					...(request.run_id ? { run_id: request.run_id } : {}),
				});
				const visible: GraphNotification[] = [];
				for (const notification of read.notifications)
					if ((await authorize(notification.run_id)) === true) visible.push(notification);
				records = visible;
				notification_cursor = read.cursor;
				content = [
					`Notifications: ${visible.length}  cursor: ${read.cursor}`,
					...visible.map(
						notification =>
							`${notification.id}  ${notification.kind}  ${notification.state}  ${notification.title ?? "-"}  ${notification.report_to ?? "-"}  ${notification.run_id}`,
					),
				].join("\n");
			} else if (operation === "wait") {
				if (!this.options.authorizeRun || (await this.options.authorizeRun(target)) !== true)
					throw graphError("permission_denied", "Run observation is not authorized");
				observation = new GraphObservation(this.options.root, GRAPH_CLI_LIMITS);
				const timeout = request.timeout_ms ?? 60_000;
				// A wait without `since` reports what happens from now on: baseline at the current
				// outbox head, so a dispatcher that just resumed does not wake on the hold it
				// already handled. Pass `since: 0` to replay committed notifications instead.
				const since = request.since ?? observation.notifications({ since: 0, limit: 1, run_id: target }).cursor;
				const started = Date.now();
				let delay = 250;
				let snapshot = observation.snapshot(target);
				let visible: GraphNotification[] = [];
				// Poll the committed outbox rather than holding a transaction: the detached
				// executor is a different process, so liveness has to come from its writes.
				while (true) {
					const read = observation.notifications({ since, limit: 200, run_id: target });
					visible = read.notifications;
					notification_cursor = read.cursor;
					if (isTerminalRunState(snapshot.run.state) || visible.length > 0) break;
					if (Date.now() - started >= timeout) break;
					await Bun.sleep(delay);
					delay = Math.min(delay * 2, 2_000);
					snapshot = observation.snapshot(target);
				}
				revision = snapshot.run.revision;
				records = [snapshot, ...visible];
				content = [
					`Run: ${target}`,
					`State: ${snapshot.run.state}`,
					`Waited: ${Date.now() - started} ms (timeout ${timeout})`,
					`Notifications: ${visible.length}`,
					...visible.map(
						notification =>
							`${notification.id}  ${notification.kind}  ${notification.state}  ${notification.title ?? "-"}`,
					),
				].join("\n");
			} else if (request.operation === "status" || request.operation === "events") {
				if (!this.options.authorizeRun || !(await this.options.authorizeRun(target)))
					throw graphError("permission_denied", "Run observation is not authorized");
				observation = new GraphObservation(this.options.root, GRAPH_CLI_LIMITS);
				if (request.operation === "status") {
					const snapshot = observation.snapshot(target);
					revision = snapshot.run.revision;
					records = [snapshot];
					content = `Run: ${target}\nState: ${snapshot.run.state}\nRevision: ${revision}`;
				} else {
					const page = observation.events(target, { after: request.after, limit: request.limit });
					records = page.events;
					next_cursor = page.next_cursor;
					content = `Run: ${target}\nEvents: ${page.events.length}\nCursor: ${page.cursor.journal_id}@${page.cursor.seq}\nWatermark: ${page.watermark.journal_id}@${page.watermark.seq}`;
				}
			} else {
				throw graphError("invalid_input", "Unsupported Graph read operation");
			}
		} catch (cause) {
			error =
				cause && typeof cause === "object" && "code" in cause && "message" in cause && !(cause instanceof Error)
					? (cause as GraphError)
					: fromError(cause);
			content = `Reason: ${error.code}: ${error.message}`;
		} finally {
			observation?.close();
			definitions?.close();
		}
		const result = {
			version: 1 as const,
			operation: request.operation,
			target_id: request.target_id ?? null,
			revision,
			records,
			...(request.operation === "templates" ? { workflows: [DAILY_CODE_WORKFLOW] } : {}),
			next_cursor,
			notification_cursor,
			content,
			error,
		};
		return { content: [{ type: "text", text: content }], details: result, isError: error !== null };
	}
}
