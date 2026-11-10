import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Args, type CommandMetadata, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseStrictFrontmatter, type StrictFrontmatter } from "@oh-my-pi/pi-utils/strict-frontmatter";
import { readBoundedUtf8, TextReadError } from "@oh-my-pi/pi-utils/stream";
import { graphHelp as commandHelp } from "../cli/command-help";
import { answerGraphRun, GraphAnswerError, type GraphAnswerAuthorization } from "./answer";
import {
	GraphAuthoringService,
	type GraphExecutionReceiptAuthorizer,
	type GraphMutation,
	type GraphOperation,
} from "./authoring";
import {
	GRAPH_CATALOG_FORMAT,
	GRAPH_NOTIFICATION_FORMAT,
	type GraphNotificationPage,
	type GraphRef,
	type GraphRunNodeProgress,
} from "@oh-my-pi/pi-wire/graph";
import { buildGraphCatalog, graphInputContract } from "./catalog";
import type { GraphDefinition } from "./contracts";
import { type GraphLimits, validateGraphDefinition } from "./definition";
import { GRAPH_CLI_LIMITS } from "./limits";
import { createLocalLifecyclePolicy } from "./local-lifecycle";
import { runLocalGraphCommand } from "./local-run";
import { renderGraphMermaid } from "./mermaid";
import { GraphNotificationConsumerCursor } from "./notification-consumer";
import {
	buildNodeProgress,
	buildRunIndex,
	GraphObservation,
	GraphObservationError,
	isTerminalRunState,
	formatNodeProgressLine,
	summarizeNodeProgress,
} from "./observation";
import { GraphObservationBridge, GraphObservationBridgeError, type GraphRunSummary } from "./observation-bridge";
import type { GraphArtifact } from "./artifacts";
import { deliverGraphNotifications, type GraphDeliveryEnvelope } from "./delivery";
import { GRAPH_INBOX_MAX_PAGE, GraphLocalInbox } from "./inbox";
import { buildGraphReport, renderGraphReportText } from "./report";
import type { GraphStartDescriptorPolicy } from "./start-descriptor";
import { GraphRunStore, type GraphLifecyclePolicy, type GraphLifecycleRequest, type GraphStartRequest } from "./store";
import { startGraphRun, type GraphStartPolicy } from "./start";
import { listGraphTemplates, readGraphTemplate } from "./templates";
import {
	GraphTextPublicationError,
	type GraphTextPublicationPolicy,
	type GraphTextPublicationRequest,
} from "./text-publication";

export const graphHelp = {
	...commandHelp,
	description:
		"Author Graph definitions or run supported bounded local Graphs. Detached execution requires a trusted embedding.",
	args: {
		action: Args.string({ description: "Graph authoring or lifecycle action", required: false }),
		parameters: Args.string({ description: "Action arguments", multiple: true }),
	},
	flags: {
		file: Flags.string({ description: "Read text/Markdown from FILE, or - for stdin" }),
		template: Flags.string({ description: "Import a bundled Graph template by name instead of a path" }),
		input: Flags.string({
			description: "Repeatable start input: NAME=FILE binds a declared input, FILE alone binds task",
		}),
		from: Flags.string({ description: "Start from a declared node" }),
		provided: Flags.string({ description: "Read imported output references from a Markdown manifest" }),
		output: Flags.string({ description: "Write exported Markdown to FILE, or - for stdout" }),
		"request-key": Flags.string({ description: "Idempotency key for the mutation" }),
		"if-revision": Flags.string({ description: "Expected Graph or Run revision" }),
		format: Flags.string({ description: "Authoring result format (json), or preview format (mermaid)" }),
		since: Flags.string({
			description: "Resume watch from JOURNAL:SEQUENCE; notifications after cursor N; inbox after line N",
		}),
		limit: Flags.string({ description: "Maximum notifications per page (1..200)" }),
		"run-id": Flags.string({ description: "Only notifications for this Run" }),
		consumer: Flags.string({ description: "Durable consumer name; resume from its saved cursor" }),
		follow: Flags.boolean({ description: "Keep polling until --timeout-ms elapses (JSON becomes NDJSON pages)" }),
		title: Flags.string({ description: "Task label stored with a dispatched Run" }),
		"report-to": Flags.string({ description: "Consumer address recorded for dispatchers; never authority" }),
		reason: Flags.string({ description: "Reason for holding or cancelling a Run" }),
		"decision-ref": Flags.string({ description: "Authorized decision as ID@DIGEST" }),
		kind: Flags.string({ description: "Hold kind: operator (default, resumable by the holder) or gate" }),
		decision: Flags.string({ description: "Human decision ID" }),
		"media-type": Flags.string({ description: "Media type of the published text artifact" }),
		"expected-digest": Flags.string({ description: "Require published content to match this sha256 digest" }),
		bindings: Flags.string({ description: "Read exact named model bindings from Markdown" }),
		"max-model-calls": Flags.string({ description: "Explicit local-run provider request limit (1..64)" }),
		"accept-workspace-write": Flags.boolean({ description: "Approve daily-code Graph workspace-wide model edits" }),
		"accept-workspace-code": Flags.boolean({
			description: "Approve executing trusted workspace code as the current OS user",
		}),
		"acceptance-check": Flags.string({
			description: "Approved daily-code acceptance check: test, typecheck or check",
		}),
		"timeout-ms": Flags.string({ description: "Explicit local-run deadline in milliseconds (1..600000)" }),
		"interval-ms": Flags.string({ description: "Monitor sweep interval in milliseconds (1000..3600000)" }),
		"stall-threshold-ms": Flags.string({ description: "Default idle threshold when a Graph declares none" }),
		"preview-chars": Flags.string({ description: "Characters of artifact text shown in a report (1..8000)" }),
		"preview-lines": Flags.string({ description: "Lines of artifact text shown in a report (1..100)" }),
		command: Flags.string({
			description: "Shell command receiving one delivery envelope on stdin; exit 0 acknowledges",
		}),
		builtin: Flags.string({ description: "Built-in delivery sink instead of --command: inbox" }),
		"delivery-timeout-ms": Flags.string({ description: "Deadline for one delivery command (1..600000)" }),
	},
	examples: [
		"omp graph create guide",
		"omp graph templates",
		"omp graph import --template requirement-spec-draft --request-key import-1",
		"omp graph import --file GRAPH.md --request-key import-1",
		"omp graph export GRAPH_ID --output GRAPH.md",
		"omp graph member add GRAPH_ID reviewer --file member.md --if-revision 1 --request-key member-1",
		"omp graph list",
		"omp graph runs --format json",
		"omp graph notifications --since 0 --format json",
		"omp graph notifications --consumer orchestrator --follow --timeout-ms 60000",
		"omp graph deliver --consumer orchestrator --command 'my-consumer' --follow --timeout-ms 60000",
		"omp graph deliver --consumer orchestrator --builtin inbox --follow --timeout-ms 60000",
		"omp graph inbox --consumer orchestrator --since 0 --format json",
		"omp graph validate GRAPH_ID",
		"omp graph preview GRAPH_ID --format mermaid",
		"omp graph run GRAPH_ID --bindings models.md --max-model-calls 8 --timeout-ms 180000 --request-key trial-1 --input task=brief.md",
		"omp graph run GRAPH_ID --bindings models.md --input task=brief.md --max-model-calls 30 --timeout-ms 300000 --request-key daily-1 --accept-workspace-write --accept-workspace-code --acceptance-check test",
		"omp graph dispatch GRAPH_ID --title review --report-to bot:orchestrator --input task=brief.md --bindings models.md --max-model-calls 8 --timeout-ms 180000 --request-key task-1",
		"omp graph request get REQUEST_KEY",
		"omp graph host ensure",
		"omp graph status RUN_ID",
		"omp graph report RUN_ID --preview-chars 800",
		"omp graph wait RUN_ID --timeout-ms 300000",
		"omp graph watch RUN_ID",
		"omp graph answer RUN_ID --decision DECISION_ID --file answer.md --if-revision 1 --request-key answer-1",
		"omp graph recover RUN_ID --reason 'verified no executor is alive'",
		"omp graph monitor --follow --interval-ms 15000 --timeout-ms 3600000",
		"omp graph artifact publish GRAPH_ID --file task.md --media-type text/markdown --request-key task-1",
		"omp graph descriptor publish GRAPH_ID --file start.json --request-key start-1",
		"omp graph descriptor get GRAPH_ID --format json",
	],
} satisfies CommandMetadata;

// Shared configuration must replace these limits when the execution Host is integrated.
export { GRAPH_CLI_LIMITS };

class CliError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function fail(message: string): never {
	throw new CliError("definition_invalid", message);
}
function exitCode(code: string): number {
	if (
		[
			"permission_denied",
			"model_unavailable",
			"base_unavailable",
			"capability_unavailable",
			"resource_limit",
			"budget_exhausted",
			"gate_unsatisfied",
			"wait_cycle",
		].includes(code)
	)
		return 3;
	if (["result_unknown", "source_unavailable", "cursor_expired", "consultation_timeout"].includes(code)) return 4;
	return code === "internal_error" ? 1 : 2;
}

const JSON_ACTIONS: Record<string, true> = {
	list: true,
	templates: true,
	runs: true,
	status: true,
	report: true,
	hold: true,
	resume: true,
	cancel: true,
	notifications: true,
	inbox: true,
	deliver: true,
	wait: true,
	create: true,
	import: true,
	edit: true,
	"member.add": true,
	"node.add": true,
	connect: true,
	permit: true,
	"request.get": true,
	export: true,
	validate: true,
	"artifact.publish": true,
	"descriptor.publish": true,
	"descriptor.get": true,
};
const MAX_JSON_BYTES = 8 * GRAPH_CLI_LIMITS.maxBytes;

/** Select error framing even if argument parsing fails before reaching --format. */
function requestsJson(argv: readonly string[]): boolean {
	const formats: (string | undefined)[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--") break;
		if (!token.startsWith("--")) continue;
		const equal = token.indexOf("=");
		const key = token.slice(2, equal < 0 ? undefined : equal);
		const value = equal < 0 ? argv[i + 1] : token.slice(equal + 1);
		const hasValue = !!value && !value.startsWith("--");
		if (key === "format") formats.push(hasValue ? value : undefined);
		if (equal < 0 && hasValue) i++;
	}
	return formats.length > 0 && formats.every(format => format === "json");
}

function printJson(value: unknown, out: (text: string) => void): void {
	const line = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_JSON_BYTES)
		throw new CliError("resource_limit", "Graph JSON output exceeds limit");
	out(line);
}

/** Installed by a trusted embedding, never by a Graph definition or command-line argument. */
export interface GraphStartAdmission extends GraphStartPolicy {
	/** Authorized, immutable and idempotent for identical name and content. */
	publishInput(principal: string, input: { name: string; content: string }): Promise<GraphRef>;
	/** Resolve the immutable execution grant; target authorization precedes CLI file access. */
	resolveAuthorization(
		principal: string,
		target: { graph_id: string; request_key: string; revision: string },
	): Promise<GraphRef>;
}

/** Trusted authentication and protected immutable answer publication for human decisions. */
export interface GraphAnswerAdmission extends GraphAnswerAuthorization {
	publishAnswer(
		principal: string,
		input: { run_id: string; decision_id: string; request_key: string; content: string },
	): Promise<GraphRef>;
}

/** CLI-only file access gate, checked before reading local files or stdin. */
export interface GraphTextPublicationAdmission extends GraphTextPublicationPolicy {
	authorizeTarget(principal: string, target: { target_id: string; request_key: string }): boolean | Promise<boolean>;
}

interface GraphCliOptions {
	root?: string;
	limits?: GraphLimits;
	/** Override bundled template discovery (tests and non-standard installations only). */
	templateRoot?: string;
	readInput?: (file: string) => string;
	writeOutput?: (file: string, content: string) => void;
	out?: (text: string) => void;
	err?: (text: string) => void;
	/** Trusted embedding policy; profile access alone does not authorize observing a Run. */
	authorizeRunObservation?: (runId: string) => boolean | Promise<boolean>;
	/** Trusted embedding supplies the authenticated principal and lifecycle policy. */
	lifecycle?: { principal: string; policy: GraphLifecyclePolicy };
	/** The standalone CLI runs as the profile owner, so it may build the local owner policy
	 * itself. Embeddings MUST pass `lifecycle` with their own principal scoping instead. */
	allowLocalLifecycle?: boolean;
	/** Trusted admission and artifact publication; absent from the production CLI until configured. */
	start?: GraphStartAdmission;
	answer?: GraphAnswerAdmission;
	publication?: GraphTextPublicationAdmission;
	/** Trusted host supply of start descriptors; the CLI never invents a policy. */
	descriptor?: GraphStartDescriptorPolicy;
	/** Separate read-only receipt permission. Never implies start, control or Run observation authority. */
	authorizeExecutionReceipt?: GraphExecutionReceiptAuthorizer;
	/** Trusted artifact read for `report`; a ref is never a grant, so the host authorizes content. */
	readArtifact?: (ref: GraphRef) => Promise<{ artifact: GraphArtifact; bytes: Uint8Array }>;
}

export async function runGraphCommand(argv: readonly string[], options: GraphCliOptions = {}): Promise<number> {
	if (argv[0] === "run" || argv[0] === "dispatch") return runLocalGraphCommand(argv.slice(1), options);
	const out = options.out ?? (text => process.stdout.write(text));
	const err = options.err ?? (text => process.stderr.write(text));
	const limits = options.limits ?? GRAPH_CLI_LIMITS;
	let store: GraphAuthoringService | undefined;
	const json = requestsJson(argv);
	try {
		const positional: string[] = [];
		const flags = new Map<string, string>();
		const inputFiles: string[] = [];
		let literal = false;
		for (let i = 0; i < argv.length; i++) {
			const token = argv[i];
			if (!literal && token === "--") {
				literal = true;
				continue;
			}
			if (literal || !token.startsWith("--")) {
				positional.push(token);
				continue;
			}
			const equal = token.indexOf("=");
			const key = token.slice(2, equal < 0 ? undefined : equal);
			if (!Object.hasOwn(graphHelp.flags, key)) fail(`Unknown flag: --${key}`);
			if (key === "input") {
				const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
				if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
				inputFiles.push(value);
				continue;
			}
			if (flags.has(key)) fail(`Duplicate flag: --${key}`);
			if (graphHelp.flags[key as keyof typeof graphHelp.flags].kind === "boolean") {
				const value = equal < 0 ? "true" : token.slice(equal + 1);
				if (value !== "true" && value !== "false") fail(`--${key} accepts true or false`);
				flags.set(key, value);
				continue;
			}
			const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
			if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
			flags.set(key, value);
		}
		let action = positional.shift();
		if ((action === "member" || action === "node") && positional.shift() === "add") action += ".add";
		else if (action === "member" || action === "node") fail(`Expected ${action} add`);
		if (action === "request") {
			if (positional.shift() !== "get") fail("Expected request get");
			action = "request.get";
		}
		if (action === "host") {
			if (positional.shift() !== "ensure") fail("Expected host ensure");
			action = "host.ensure";
		}
		if (action === "artifact") {
			if (positional.shift() !== "publish") fail("Expected artifact publish");
			action = "artifact.publish";
		}
		if (action === "descriptor") {
			const verb = positional.shift();
			if (verb !== "publish" && verb !== "get") fail("Expected descriptor publish or descriptor get");
			action = `descriptor.${verb}`;
		}
		const definitions: Record<string, { count: number; flags: string[] }> = {
			create: { count: 1, flags: ["request-key"] },
			import: { count: 0, flags: ["file", "request-key", "template"] },
			edit: { count: 1, flags: ["file", "request-key", "if-revision"] },
			"member.add": { count: 2, flags: ["file", "request-key", "if-revision"] },
			"node.add": { count: 2, flags: ["file", "request-key", "if-revision"] },
			connect: { count: 1, flags: ["file", "request-key", "if-revision"] },
			permit: { count: 1, flags: ["file", "request-key", "if-revision"] },
			export: { count: 1, flags: ["output"] },
			validate: { count: 1, flags: [] },
			preview: { count: 1, flags: ["format"] },
			list: { count: 0, flags: [] },
			templates: { count: 0, flags: [] },
			runs: { count: 0, flags: [] },
			notifications: { count: 0, flags: ["since", "limit", "run-id", "consumer", "follow", "timeout-ms"] },
			inbox: { count: 0, flags: ["since", "limit", "consumer"] },
			deliver: {
				count: 0,
				flags: ["limit", "consumer", "command", "builtin", "follow", "timeout-ms", "delivery-timeout-ms"],
			},
			"request.get": { count: 1, flags: [] },
			"host.ensure": { count: 0, flags: [] },
			status: { count: 1, flags: [] },
			report: { count: 1, flags: ["preview-chars", "preview-lines"] },
			wait: { count: 1, flags: ["since", "timeout-ms", "format"] },
			watch: { count: 1, flags: ["since"] },
			start: { count: 1, flags: ["request-key", "if-revision", "input", "from", "provided"] },
			answer: { count: 1, flags: ["decision", "file", "request-key", "if-revision"] },
			hold: { count: 1, flags: ["request-key", "if-revision", "reason", "kind"] },
			resume: { count: 1, flags: ["request-key", "if-revision", "decision-ref", "kind"] },
			cancel: { count: 1, flags: ["request-key", "if-revision", "reason"] },
			recover: { count: 1, flags: ["reason", "if-revision"] },
			monitor: { count: 0, flags: ["follow", "interval-ms", "timeout-ms", "stall-threshold-ms"] },
			"artifact.publish": { count: 1, flags: ["file", "media-type", "expected-digest", "request-key"] },
			"descriptor.publish": { count: 1, flags: ["file", "expected-digest", "request-key"] },
			"descriptor.get": { count: 1, flags: ["request-key"] },
		};
		if (!action || !Object.hasOwn(definitions, action)) fail(`Unsupported Graph command: ${action ?? "(none)"}`);
		const spec = definitions[action];
		if (positional.length !== spec.count || positional.some(value => !value)) fail(`Invalid arguments for ${action}`);
		const format = flags.get("format");
		if (format !== undefined) {
			if (action === "preview") {
				if (format !== "mermaid") fail("Only mermaid preview is supported");
			} else if (format !== "json" || !Object.hasOwn(JSON_ACTIONS, action)) {
				fail(`Format ${format} is not supported for ${action}`);
			}
		}
		for (const key of flags.keys())
			if (!spec.flags.includes(key) && !(key === "format" && Object.hasOwn(JSON_ACTIONS, action)))
				fail(`Flag --${key} is not valid for ${action}`);
		if (inputFiles.length > 0 && !spec.flags.includes("input")) fail(`Flag --input is not valid for ${action}`);
		if (json && action === "export" && flags.get("output") !== "-") fail("JSON export requires --output=-");
		const requireFlag = (key: string): string => flags.get(key) ?? fail(`Missing --${key}`);
		const readTextFile = async (file: string): Promise<string> => {
			try {
				if (options.readInput) {
					const content = options.readInput(file);
					if (Buffer.byteLength(content, "utf8") > limits.maxBytes) throw new TextReadError("too_large");
					return content;
				}
				return await readBoundedUtf8(file === "-" ? Bun.stdin.stream() : Bun.file(file).stream(), limits.maxBytes);
			} catch (error) {
				if (error instanceof TextReadError)
					throw new CliError(error.code === "too_large" ? "resource_limit" : "definition_invalid", error.message);
				throw new CliError(
					(error as NodeJS.ErrnoException).code === "EACCES" ? "permission_denied" : "definition_invalid",
					`Cannot read ${file}`,
				);
			}
		};
		const readFile = (): Promise<string> => readTextFile(requireFlag("file"));
		if (action === "artifact.publish") {
			const admission = options.publication;
			if (!admission)
				throw new CliError("capability_unavailable", "Graph artifact publication requires trusted admission");
			const principal = admission.principal;
			const target = { target_id: positional[0], request_key: requireFlag("request-key") };
			if (!principal || (await admission.authorizeTarget(principal, { ...target })) !== true)
				throw new CliError("permission_denied", "Graph artifact target authorization denied");
			const mediaType = requireFlag("media-type");
			const request: GraphTextPublicationRequest = {
				version: 1,
				operation: "artifact.publish",
				...target,
				if_revision: null,
				payload: {
					content: await readFile(),
					media_type: mediaType,
					expected_digest: flags.get("expected-digest") ?? null,
				},
			};
			const runs = new GraphRunStore(limits, options.root);
			try {
				const result = await runs.configureTextPublications({ ...admission, principal }).publish(request);
				if (json) printJson({ schema_version: 1, kind: "graph.operation", operation: result }, out);
				else {
					printOperation(result, out, false, "Target");
					if (result.result_ref) out(`Artifact: ${result.result_ref.id}@${result.result_ref.digest}\n`);
				}
				return result.error ? exitCode(result.error.code) : 0;
			} finally {
				runs.close();
			}
		}
		if (action === "descriptor.publish" || action === "descriptor.get") {
			const admission = options.descriptor;
			if (!admission)
				throw new CliError("capability_unavailable", "Graph start descriptors require trusted host admission");
			const graphId = positional[0];
			const runs = new GraphRunStore(limits, options.root);
			try {
				const descriptors = runs.configureStartDescriptors(admission);
				if (action === "descriptor.get") {
					const reference = await descriptors.get(graphId, flags.get("request-key") ?? null);
					if (json)
						printJson(
							{
								schema_version: 1,
								kind: "graph.start-descriptor",
								graph_id: graphId,
								descriptor_ref: reference,
							},
							out,
						);
					else
						out(
							reference
								? `Descriptor: ${reference.id}@${reference.digest}  recorded: ${reference.created_at}\n`
								: "Descriptor: none\n",
						);
					return 0;
				}
				const result = await descriptors.publish({
					request_key: requireFlag("request-key"),
					graph_id: graphId,
					content: await readFile(),
					expected_digest: flags.get("expected-digest") ?? null,
				});
				if (json) printJson({ schema_version: 1, kind: "graph.operation", operation: result }, out);
				else {
					out(`Request: ${result.request_key}\nState: ${result.state}\n`);
					if (result.descriptor_ref)
						out(`Descriptor: ${result.descriptor_ref.id}@${result.descriptor_ref.digest}\n`);
					if (result.error) out(`Reason: ${result.error.code}: ${result.error.message}\n`);
				}
				return result.error ? exitCode(result.error.code) : 0;
			} finally {
				runs.close();
			}
		}
		if (action === "start") {
			const admission = options.start;
			if (!admission)
				throw new CliError(
					"capability_unavailable",
					"Graph start requires trusted preflight, authenticated authorization, executor configuration and result verification, which are not configured",
				);
			const target = {
				graph_id: positional[0],
				request_key: requireFlag("request-key"),
				revision: requireFlag("if-revision"),
			};
			if (!admission.principal || (await admission.authorizeTarget(admission.principal, { ...target })) !== true)
				throw new CliError("permission_denied", "Graph start target authorization denied");
			// Repeatable `--input NAME=FILE`; a bare FILE keeps the legacy `task` binding.
			const parsedInputs = new Map<string, { file: string; explicit: boolean }>();
			for (const raw of inputFiles) {
				const split = raw.indexOf("=");
				const explicit = split > 0 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(raw.slice(0, split));
				const name = explicit ? raw.slice(0, split) : "task";
				const file = explicit ? raw.slice(split + 1) : raw;
				if (parsedInputs.has(name)) fail(`Duplicate --input ${name}`);
				if (!file) fail("--input FILE must be a readable path");
				parsedInputs.set(name, { file, explicit });
			}
			const from = flags.get("from");
			const providedFile = flags.get("provided");
			if (providedFile && !from) fail("--provided requires --from");
			const stdinReaders =
				[...parsedInputs.values()].map(input => input.file).filter(file => file === "-").length +
				(providedFile === "-" ? 1 : 0);
			if (stdinReaders > 1) fail("Only one input can read stdin");
			const runs = new GraphRunStore(limits, options.root);
			try {
				const snapshot = runs.definitions.get(target.graph_id);
				if (snapshot && parsedInputs.size > 0) {
					// The imported contract, not the caller, decides which inputs exist. A graph that
					// declares no inputs keeps the legacy bare-FILE `task` binding for compatibility.
					const definition = validateGraphDefinition(snapshot.content, limits).source.frontmatter
						.frontmatter as unknown as GraphDefinition;
					const accepted = new Set(graphInputContract(definition).map(input => input.name));
					for (const [name, input] of parsedInputs) {
						if (accepted.has(name)) continue;
						if (!input.explicit && name === "task" && accepted.size === 0) continue;
						fail(
							`Graph does not accept input: ${name}${accepted.size ? ` (accepts ${[...accepted].join(", ")})` : ""}`,
						);
					}
				}
				let providedOutputs: Record<string, Record<string, GraphRef>> | undefined;
				if (providedFile) {
					const content = await readTextFile(providedFile);
					const data = parseStrictFrontmatter(content, limits).frontmatter;
					if (
						Object.keys(data).some(key => key !== "outputs") ||
						!data.outputs ||
						typeof data.outputs !== "object" ||
						Array.isArray(data.outputs)
					)
						fail("Provided manifest requires an outputs map");
					providedOutputs = {};
					for (const [node, value] of Object.entries(data.outputs)) {
						if (!/^[a-z][a-z0-9-]*$/.test(node) || !value || typeof value !== "object" || Array.isArray(value))
							fail("Invalid provided node outputs");
						const outputs: Record<string, GraphRef> = {};
						for (const [name, ref] of Object.entries(value)) {
							if (
								!/^[a-z][a-z0-9-]*$/.test(name) ||
								!ref ||
								typeof ref !== "object" ||
								Array.isArray(ref) ||
								Object.keys(ref).some(key => key !== "id" && key !== "digest") ||
								!("id" in ref) ||
								typeof ref.id !== "string" ||
								!ref.id ||
								!("digest" in ref) ||
								typeof ref.digest !== "string" ||
								!ref.digest
							)
								fail("Invalid provided output reference");
							outputs[name] = { id: ref.id, digest: ref.digest };
						}
						providedOutputs[node] = outputs;
					}
				}
				const inputs: Record<string, GraphRef> = {};
				for (const [name, input] of parsedInputs) {
					const content = await readTextFile(input.file);
					inputs[name] = await admission.publishInput(admission.principal, { name, content });
				}
				const request: GraphStartRequest = {
					version: 1,
					operation: "start",
					request_key: target.request_key,
					target_id: target.graph_id,
					if_revision: target.revision,
					payload: {
						inputs,
						authorization_ref: await admission.resolveAuthorization(admission.principal, target),
						...(from ? { entry_nodes: [from] } : {}),
						...(providedOutputs ? { provided_outputs: providedOutputs } : {}),
					},
				};
				const result = await startGraphRun(runs, admission, request);
				printOperation(result, out, false, "Run");
				return result.error ? exitCode(result.error.code) : 0;
			} finally {
				runs.close();
			}
		}
		if (action === "answer") {
			const admission = options.answer;
			if (!admission)
				throw new CliError("capability_unavailable", "Graph answer requires authenticated human authorization");
			const principal = admission.principal;
			const target = {
				run_id: positional[0],
				decision_id: requireFlag("decision"),
				request_key: requireFlag("request-key"),
			};
			const revision = requireFlag("if-revision");
			if (!principal || (await admission.authorizeTarget(principal, { ...target })) !== true)
				throw new CliError("permission_denied", "Graph answer target authorization denied");
			const runs = new GraphRunStore(limits, options.root);
			try {
				runs.configureHuman(admission.authorize);
				const decision = runs.getHumanQuestion(principal, target.decision_id);
				if (!decision || decision.run_id !== target.run_id)
					throw new CliError("unknown_reference", "Human decision does not exist in this Run");
				const parsed = parseStrictFrontmatter(await readFile(), limits);
				const data = parsed.frontmatter;
				if (
					Object.keys(data).some(key => !["outcome", "input_digest", "verdict"].includes(key)) ||
					typeof data.outcome !== "string" ||
					!data.outcome ||
					typeof data.input_digest !== "string" ||
					!data.input_digest ||
					(data.verdict !== undefined && (typeof data.verdict !== "string" || !data.verdict))
				)
					fail("Answer front matter requires outcome and input_digest, with optional verdict");
				const published = await admission.publishAnswer(principal, { ...target, content: parsed.body });
				const contentRef = { id: published.id, digest: published.digest };
				const result = await answerGraphRun(
					runs,
					{ ...admission, principal, resolveContent: async () => parsed.body },
					{
						version: 1,
						operation: "answer",
						request_key: target.request_key,
						target_id: target.run_id,
						if_revision: revision,
						payload: {
							decision_id: target.decision_id,
							input_digest: data.input_digest,
							outcome: data.outcome,
							verdict: (data.verdict as string | undefined) ?? data.outcome,
							content_ref: contentRef,
						},
					},
				);
				printOperation(result, out, false, "Run");
				return result.error ? exitCode(result.error.code) : 0;
			} finally {
				runs.close();
			}
		}
		if (action === "hold" || action === "resume" || action === "cancel") {
			const lifecycle =
				options.lifecycle ??
				(options.allowLocalLifecycle ? { principal: "local-user", policy: createLocalLifecyclePolicy() } : null);
			if (!lifecycle)
				throw new CliError(
					"capability_unavailable",
					`Graph ${action} requires an authorized lifecycle control API, which is not configured`,
				);
			const common = {
				version: 1 as const,
				request_key: requireFlag("request-key"),
				target_id: positional[0],
				if_revision: requireFlag("if-revision"),
			};
			const kind = flags.get("kind");
			if (kind !== undefined && kind !== "operator" && kind !== "gate")
				fail("Invalid --kind; expected operator or gate");
			let request: GraphLifecycleRequest;
			if (action === "resume") {
				const ref = flags.get("decision-ref");
				if (ref !== undefined) {
					if (kind === "gate") fail("--kind gate cannot be combined with --decision-ref");
					const separator = ref.lastIndexOf("@");
					if (separator <= 0 || separator === ref.length - 1) fail("Invalid --decision-ref; expected ID@DIGEST");
					request = {
						...common,
						operation: action,
						payload: { decision_ref: { id: ref.slice(0, separator), digest: ref.slice(separator + 1) } },
					};
				} else {
					// An operator pause is lifted by the same principal; a gate hold is not.
					if (kind === "gate") fail("Resuming a gate hold requires --decision-ref");
					request = { ...common, operation: action, payload: { kind: "operator" } };
				}
			} else {
				request = {
					...common,
					operation: action,
					payload: {
						reason: flags.get("reason") ?? `User requested ${action}`,
						// A human/agent pause from the CLI is a scheduling pause; `--kind gate`
						// opts into the decision-gated form instead.
						...(action === "hold" ? { kind: kind ?? "operator" } : {}),
					},
				};
			}
			const runs = new GraphRunStore(limits, options.root);
			try {
				runs.configureLifecycle(lifecycle.policy);
				const result = runs.mutateLifecycle(lifecycle.principal, request);
				if (json) printJson({ schema_version: 1, kind: "graph.operation", operation: result }, out);
				else printOperation(result, out, false, "Run");
				return result.error ? exitCode(result.error.code) : 0;
			} finally {
				runs.close();
			}
		}
		if (action === "recover") {
			const reason = flags.get("reason");
			if (!reason?.trim()) fail("--reason is required; record how you verified the execution stopped");
			const runs = new GraphRunStore(limits, options.root);
			try {
				const owner = runs.claimHost();
				if (!owner)
					throw new CliError(
						"capability_unavailable",
						"Another Graph host owns this profile; recovery requires the executor to be gone",
					);
				const runId = positional[0];
				const run = runs.getRun(runId);
				if (!run) throw new CliError("unknown_reference", "Graph Run does not exist");
				if (run.state !== "held" && run.state !== "cancelling")
					throw new CliError(
						"gate_unsatisfied",
						`Only a held or cancelling Run is recoverable; this Run is ${run.state}`,
					);
				const expected = flags.get("if-revision");
				if (expected !== undefined && expected !== run.revision)
					throw new CliError("gate_unsatisfied", `Run is at revision ${run.revision}, not ${expected}`);
				const frozen = runs.getFrozenDefinition(runId);
				const observed = `${reason.trim()} (local profile owner; no live foreground Graph host)`;
				const termination = (key: string): GraphRef => ({
					id: `local-recover:${key}`,
					digest: `sha256:${Bun.SHA256.hash(`${observed}\0${key}`, "hex")}`,
				});
				const recovered: string[] = [];
				for (const intent of runs.getDispatchIntents(runId)) {
					if (intent.state !== "unknown") continue;
					const invocation = runs
						.getScheduleState(runId)
						?.invocations.find(item => item.id === intent.invocation_id);
					const node = invocation && frozen?.nodes[invocation.node];
					// Only a Bot attempt can be closed from an operator attestation. Programs,
					// queues and human waits keep their own executor-bound recovery paths.
					if (!node || node.kind !== "bot" || invocation?.consultation) continue;
					runs.reconcileBotExecution(owner.owner_id, owner.epoch, {
						identity: {
							run_id: intent.run_id,
							intent_id: intent.id,
							invocation_id: intent.invocation_id,
							attempt_id: intent.attempt_id,
							fence: intent.fence,
							request_key: intent.request_key,
						},
						if_revision: runs.getRun(runId)!.revision,
						termination_ref: termination(intent.id),
						observed,
					});
					recovered.push(intent.id);
				}
				// Attesting unknown Bot intents can itself settle a cancelling Run: reconciliation
				// flips cancellation to cancelled once no effect is left unresolved. Only a Run that
				// is still held needs the closure step, and a Run still cancelling has an attempt the
				// operator attestation could not account for.
				const settled = runs.getRun(runId)!;
				if (settled.state === "cancelling")
					throw new CliError(
						"gate_unsatisfied",
						"Run is still cancelling: an unresolved attempt was not attested; inspect its intents and consultations",
					);
				const closed =
					settled.state === "held"
						? runs.closeHeldRun(owner.owner_id, owner.epoch, {
								run_id: runId,
								if_revision: settled.revision,
								reason: `Recovered: ${reason.trim()}`,
							})
						: settled;
				const writers = runs
					.getProfileWriterAdmissions(owner.owner_id, owner.epoch)
					.filter(admission => admission.run_id === runId);
				for (const identity of writers)
					runs.reconcileProfileWriter(owner.owner_id, owner.epoch, {
						identity,
						if_revision: closed.revision,
						termination_ref: termination(identity.admission_id),
						observed,
					});
				if (json)
					printJson(
						{
							schema_version: 1,
							kind: "graph.recovery",
							run_id: runId,
							state: closed.state,
							revision: closed.revision,
							reconciled_intents: recovered,
							released_writers: writers.length,
						},
						out,
					);
				else {
					out(`Run: ${runId}\nState: ${closed.state}\nRevision: ${closed.revision}\n`);
					out(`Reconciled attempts: ${recovered.length}\nReleased profile writers: ${writers.length}\n`);
				}
				return 0;
			} finally {
				runs.close();
			}
		}
		if (action === "monitor") {
			// A stall alarm is observation data appended to the same outbox as transitions. It
			// never changes Run state, so it is safe while a detached host owns the profile.
			const follow = flags.get("follow") === "true";
			const intervalFlag = flags.get("interval-ms");
			const interval = intervalFlag === undefined ? 15_000 : Number(intervalFlag);
			if (!Number.isInteger(interval) || interval < 1_000 || interval > 3_600_000)
				fail("--interval-ms must be 1000..3600000");
			const timeoutFlag = flags.get("timeout-ms");
			const timeout = timeoutFlag === undefined ? 60_000 : Number(timeoutFlag);
			if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000) fail("--timeout-ms must be 1..3600000");
			const thresholdFlag = flags.get("stall-threshold-ms");
			const defaultThresholdMs = thresholdFlag === undefined ? undefined : Number(thresholdFlag);
			if (defaultThresholdMs !== undefined && (!Number.isSafeInteger(defaultThresholdMs) || defaultThresholdMs < 1))
				fail("--stall-threshold-ms must be a positive integer");
			const runs = new GraphRunStore(limits, options.root);
			try {
				const deadline = Date.now() + timeout;
				for (;;) {
					const raised = await runs.emitStallNotifications({
						...(defaultThresholdMs !== undefined ? { defaultThresholdMs } : {}),
						...(options.authorizeRunObservation ? { authorize: options.authorizeRunObservation } : {}),
					});
					for (const alarm of raised)
						out(`Stalled: ${alarm.run_id}  idle-since ${alarm.activity_at}  threshold ${alarm.threshold_ms}ms\n`);
					if (!follow || Date.now() >= deadline) return 0;
					await Bun.sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
				}
			} finally {
				runs.close();
			}
		}
		if (action === "templates") {
			const listing = await listGraphTemplates(limits, options.templateRoot ? { root: options.templateRoot } : {});
			if (json) printJson({ schema_version: 1, kind: "graph.templates", ...listing }, out);
			else if (!listing.root) out("No bundled Graph templates are available\n");
			else if (!listing.templates.length) out("No Graph templates are available\n");
			else
				for (const template of listing.templates) {
					const entry = template.entry;
					out(`${template.template}  ${template.path}\n`);
					if (!entry || template.error) out(`  invalid: ${template.error ?? "contract unavailable"}\n`);
					else
						out(
							`  summary:${entry.summary ? ` ${entry.summary}` : " not declared"}  in:${entry.inputs.map(input => input.name).join(",") || "-"}  out:${entry.outputs.map(output => output.name).join(",") || "-"}  bind:${entry.bindings ?? "-"}  local:${entry.local_run.supported ? "yes" : "no"}  deliver:${entry.deliverable?.artifacts.join(",") || "-"}\n`,
						);
				}
			if (!json)
				for (const workflow of listing.workflows)
					out(`Host workflow: ${workflow.id} (not importable as a Graph); ${workflow.command.join(" ")}\n`);
			return 0;
		}
		if (action === "list" || action === "runs") {
			if (action === "list") {
				store = new GraphAuthoringService(limits, options.root);
				const entries = buildGraphCatalog(store.listDefinitions(), limits);
				if (json) printJson({ format: GRAPH_CATALOG_FORMAT, entries }, out);
				else if (!entries.length) out("No Graph definitions are available\n");
				else
					for (const entry of entries)
						out(
							`${entry.graph_id}  ${entry.name}  r${entry.revision}  in:${entry.inputs.map(input => input.name).join(",") || "-"}  out:${entry.outputs.map(output => output.name).join(",") || "-"}  bind:${entry.bindings ?? "-"}  local:${entry.local_run.supported ? "yes" : "no"}  deliver:${entry.deliverable?.artifacts.join(",") || "-"}${entry.duplicates ? `  dup:+${entry.duplicates}` : ""}\n`,
						);
				return 0;
			}
			const authorize = options.authorizeRunObservation;
			if (!authorize)
				throw new CliError("permission_denied", "Graph Run observation authorization is not configured");
			let observation: GraphObservation | undefined;
			try {
				observation = new GraphObservation(options.root, limits);
				const index = await buildRunIndex(observation, authorize);
				if (json) printJson(index, out);
				else {
					out(`Runs: ${index.runs.length}  as of ${index.as_of}\n`);
					for (const run of index.runs) {
						const summary = run.activity_summary
							? `  ${run.activity_summary.length > 80 ? `${run.activity_summary.slice(0, 79)}…` : run.activity_summary}`
							: "";
						const progress = summarizeNodeProgress(run.nodes);
						out(
							`${run.run_id}  ${run.title ? `${run.title}  ` : ""}${run.graph_id}  ${run.state}${run.hold_kind ? `(${run.hold_kind})` : ""}${run.stalled ? "  STALLED" : ""}${progress ? `  ${progress}` : ""}${run.deliverable ? `  deliver:${run.deliverable.ready ? "ready" : `pending(${run.deliverable.missing.join(",")})`}` : ""}  ${run.last_event ?? "created"}  ${run.last_activity_at}${run.turn_count !== undefined ? `  turns:${run.turn_count}` : ""}${summary}\n`,
						);
					}
				}
				return 0;
			} finally {
				observation?.close();
			}
		}
		if (action === "notifications") {
			const authorize = options.authorizeRunObservation;
			if (!authorize)
				throw new CliError("permission_denied", "Graph Run observation authorization is not configured");
			const root = options.root ?? path.join(getAgentDir(), "graphs");
			const consumerFlag = flags.get("consumer");
			const consumer =
				consumerFlag === undefined ? undefined : new GraphNotificationConsumerCursor(root, consumerFlag);
			const sinceFlag = flags.get("since");
			const since = sinceFlag === undefined ? (consumer?.read() ?? 0) : Number(sinceFlag);
			if (!Number.isInteger(since) || since < 0) fail("--since must be a non-negative integer cursor");
			const limitFlag = flags.get("limit");
			const limit = limitFlag === undefined ? 50 : Number(limitFlag);
			if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("--limit must be 1..200");
			const runId = flags.get("run-id");
			const follow = flags.get("follow") === "true";
			const timeoutFlag = flags.get("timeout-ms");
			const followTimeout = timeoutFlag === undefined ? 60_000 : Number(timeoutFlag);
			if (!Number.isInteger(followTimeout) || followTimeout < 1 || followTimeout > 600_000)
				fail("--timeout-ms must be 1..600000");
			let observation: GraphObservation | undefined;
			try {
				observation = new GraphObservation(options.root, limits);
				const deadline = Date.now() + (follow ? followTimeout : 0);
				let cursor = since;
				for (;;) {
					const read = observation.notifications({ since: cursor, limit, ...(runId ? { run_id: runId } : {}) });
					const visible: GraphNotificationPage["notifications"] = [];
					for (const notification of read.notifications)
						if ((await authorize(notification.run_id)) === true) visible.push(notification);
					cursor = read.cursor;
					if (!follow || visible.length > 0) {
						const page: GraphNotificationPage = {
							format: GRAPH_NOTIFICATION_FORMAT,
							as_of: new Date().toISOString(),
							cursor: read.cursor,
							notifications: visible,
						};
						if (json) {
							if (!follow) printJson(page, out);
							else out(`${JSON.stringify(page)}\n`);
						} else {
							if (!follow) out(`Notifications: ${visible.length}  cursor: ${page.cursor}\n`);
							for (const notification of visible)
								out(
									`${notification.id}  ${notification.kind}  ${notification.title ?? "-"}  ${notification.report_to ?? "-"}  ${notification.run_id}\n`,
								);
						}
					}
					consumer?.advance(read.cursor);
					if (!follow || Date.now() >= deadline) return 0;
					await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
				}
			} finally {
				observation?.close();
			}
		}
		if (action === "deliver") {
			const authorize = options.authorizeRunObservation;
			if (!authorize)
				throw new CliError("permission_denied", "Graph Run observation authorization is not configured");
			const consumerName = flags.get("consumer");
			if (consumerName === undefined) fail("--consumer is required for deliver");
			const rawCommand = flags.get("command");
			const builtin = flags.get("builtin");
			if ((rawCommand === undefined) === (builtin === undefined))
				fail("deliver requires exactly one of --command or --builtin");
			if (rawCommand !== undefined && rawCommand.trim() === "") fail("--command requires a non-empty shell command");
			if (builtin !== undefined && builtin !== "inbox") fail("Only --builtin inbox is supported");
			const rawLimit = flags.get("limit");
			const limit = rawLimit === undefined ? 50 : Number(rawLimit);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("--limit must be an integer in 1..200");
			const rawFollow = flags.get("timeout-ms");
			const followTimeoutMs = rawFollow === undefined ? 60_000 : Number(rawFollow);
			if (!Number.isSafeInteger(followTimeoutMs) || followTimeoutMs < 1 || followTimeoutMs > 600_000)
				fail("--timeout-ms must be an integer in 1..600000");
			const rawDelivery = flags.get("delivery-timeout-ms");
			const deliveryTimeoutMs = rawDelivery === undefined ? 30_000 : Number(rawDelivery);
			if (!Number.isSafeInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 1 || deliveryTimeoutMs > 600_000)
				fail("--delivery-timeout-ms must be an integer in 1..600000");
			const root = options.root ?? path.join(getAgentDir(), "graphs");
			// The inbox sink appends and fsyncs before returning 0, so the durable consumer cursor
			// only advances past records that are actually on disk.
			const inbox = builtin === "inbox" ? new GraphLocalInbox(root, consumerName) : undefined;
			const result = await deliverGraphNotifications({
				root,
				consumer: consumerName,
				...(rawCommand !== undefined ? { command: ["/bin/sh", "-c", rawCommand] } : {}),
				...(inbox
					? {
							deliver: async (envelope: GraphDeliveryEnvelope) => {
								inbox.append(envelope);
								return { exitCode: 0, timedOut: false };
							},
						}
					: {}),
				limit,
				timeoutMs: deliveryTimeoutMs,
				follow: flags.get("follow") === "true",
				followTimeoutMs,
				authorize,
			});
			if (json) printJson(result, out);
			else {
				for (const id of result.delivered) out(`Delivered: ${id}\n`);
				out(`Delivered ${result.delivered.length}  cursor: ${result.cursor}\n`);
			}
			if (result.failure) {
				err(
					`delivery_failed: ${result.failure.id} exit ${result.failure.exit_code ?? "unknown"}${result.failure.timed_out ? " (timed out)" : ""}; cursor not advanced past that page\n`,
				);
				return 1;
			}
			return 0;
		}
		if (action === "inbox") {
			// Reading the inbox discloses only records this consumer already acknowledged; it never
			// observes a Run, so it needs no separate Run authorization.
			const consumerName = flags.get("consumer");
			if (consumerName === undefined) fail("--consumer is required for inbox");
			const rawSince = flags.get("since");
			const since = rawSince === undefined ? 0 : Number(rawSince);
			if (!Number.isSafeInteger(since) || since < 0) fail("--since must be a non-negative integer");
			const rawLimit = flags.get("limit");
			const limit = rawLimit === undefined ? 50 : Number(rawLimit);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > GRAPH_INBOX_MAX_PAGE)
				fail(`--limit must be an integer in 1..${GRAPH_INBOX_MAX_PAGE}`);
			const page = new GraphLocalInbox(options.root ?? path.join(getAgentDir(), "graphs"), consumerName).read({
				since,
				limit,
			});
			if (json) printJson(page, out);
			else {
				out(`Inbox: ${page.consumer}  records: ${page.records.length}  cursor: ${page.cursor}\n`);
				for (const record of page.records)
					out(
						`${record.notification.id}  ${record.notification.kind}  ${record.notification.title ?? "-"}  ${record.delivered_at}  ${record.notification.run_id}\n`,
					);
			}
			return 0;
		}
		if (action === "wait") {
			if (!options.authorizeRunObservation)
				throw new CliError("permission_denied", "Graph Run observation authorization is not configured");
			const runId = positional[0];
			if ((await options.authorizeRunObservation(runId)) !== true)
				throw new CliError("permission_denied", "Graph Run observation is not authorized");
			const rawTimeout = flags.get("timeout-ms");
			const timeout = rawTimeout === undefined ? 60_000 : Number(rawTimeout);
			if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 3_600_000)
				fail("--timeout-ms must be an integer in 1000..3600000");
			const rawSince = flags.get("since");
			let observation: GraphObservation | undefined;
			try {
				observation = new GraphObservation(options.root, limits);
				// Without `--since` a wait reports what happens from now on, so a resume does not
				// wake on the hold it just cleared; `--since 0` replays committed notifications.
				const since =
					rawSince === undefined
						? observation.notifications({ since: 0, limit: 1, run_id: runId }).cursor
						: Number(rawSince);
				if (!Number.isSafeInteger(since) || since < 0) fail("--since must be a non-negative integer cursor");
				const started = Date.now();
				let delay = 250;
				let current = observation.snapshot(runId);
				let page = observation.notifications({ since, limit: 200, run_id: runId });
				// The detached executor is another process, so the only truthful liveness signal
				// is its committed writes: poll the same outbox every consumer reads.
				while (true) {
					if (isTerminalRunState(current.run.state) || page.notifications.length > 0) break;
					if (Date.now() - started >= timeout) break;
					await Bun.sleep(delay);
					delay = Math.min(delay * 2, 2_000);
					current = observation.snapshot(runId);
					page = observation.notifications({ since, limit: 200, run_id: runId });
				}
				const waited = Date.now() - started;
				if (flags.get("format") === "json")
					printJson(
						{
							schema_version: 1,
							kind: "graph.wait",
							run_id: runId,
							state: current.run.state,
							waited_ms: waited,
							timeout_ms: timeout,
							cursor: page.cursor,
							notifications: page.notifications,
						},
						out,
					);
				else {
					printRun(current.run, out);
					out(`Waited: ${waited} ms (timeout ${timeout})\n`);
					for (const notification of page.notifications)
						out(`Notification: ${notification.id}  ${notification.kind}  ${notification.state}\n`);
				}
				return 0;
			} finally {
				observation?.close();
			}
		}
		if (action === "report") {
			const authorize = options.authorizeRunObservation;
			const readArtifact = options.readArtifact;
			if (!authorize || !readArtifact)
				throw new CliError(
					"permission_denied",
					"Graph Run report requires observation and artifact-read authorization",
				);
			const runId = positional[0];
			if ((await authorize(runId)) !== true)
				throw new CliError("permission_denied", "Graph Run observation is not authorized");
			const bounded = (flag: string, fallback: number, max: number): number => {
				const raw = flags.get(flag);
				if (raw === undefined) return fallback;
				const value = Number(raw);
				if (!Number.isSafeInteger(value) || value < 1 || value > max)
					fail(`--${flag} must be an integer in 1..${max}`);
				return value;
			};
			const previewChars = bounded("preview-chars", 1200, 8000);
			const previewLines = bounded("preview-lines", 24, 100);
			let observation: GraphObservation | undefined;
			try {
				observation = new GraphObservation(options.root, limits);
				const report = await buildGraphReport(observation, runId, {
					readArtifact,
					previewChars,
					previewLines,
				});
				if (json) printJson(report, out);
				else out(renderGraphReportText(report));
				return 0;
			} finally {
				observation?.close();
			}
		}
		if (action === "status" || action === "watch") {
			if (!options.authorizeRunObservation)
				throw new CliError("permission_denied", "Graph Run observation authorization is not configured");
			let observation: GraphObservation | undefined;
			try {
				observation = new GraphObservation(options.root, limits);
				const bridge = new GraphObservationBridge(observation, (_principal: null, runId) =>
					options.authorizeRunObservation!(runId),
				);
				const snapshot = await bridge.snapshot(null, positional[0]);
				if (json) {
					// Reuse the run-index projection so `status --format json` cannot drift from
					// `runs --format json`; authorization is narrowed to the requested Run.
					const index = await buildRunIndex(observation!, (runId: string) => runId === positional[0]);
					const entry = index.runs[0];
					if (!entry) throw new CliError("permission_denied", "Graph Run observation authorization denied");
					printJson(
						{ schema_version: 1, kind: "graph.status", as_of: index.as_of, run: entry, cursor: snapshot.cursor },
						out,
					);
					return 0;
				}
				printRun(snapshot.run, out);
				// Node progress answers the first question a dispatcher asks: which step is
				// executing, and which already finished. It comes from committed schedule state.
				const progress = (state: typeof snapshot.run.state) =>
					buildNodeProgress(observation!, positional[0], state);
				const first = progress(snapshot.run.state);
				let lastNodes: Map<string, GraphRunNodeProgress["state"]> | undefined;
				if (first?.nodes.length) {
					const summary = summarizeNodeProgress(first.nodes);
					if (summary) out(`Progress: ${summary}\n`);
					lastNodes = printNodes(first.nodes, first.omitted || undefined, out);
				}
				if (action === "watch") {
					const since = flags.get("since");
					const split = since?.lastIndexOf(":") ?? -1;
					if (since && (split <= 0 || !/^(0|[1-9][0-9]*)$/.test(since.slice(split + 1))))
						fail("Invalid --since cursor; expected JOURNAL:SEQUENCE");
					let cursor = since
						? { journal_id: since.slice(0, split), seq: since.slice(split + 1) }
						: snapshot.cursor;
					if (since) await bridge.events(null, positional[0], { after: cursor, limit: 1 });
					let current = snapshot;
					let printedRevision = snapshot.run.revision;
					while (!isTerminal(current.run.state) || BigInt(cursor.seq) < BigInt(current.cursor.seq)) {
						const page = await bridge.events(null, positional[0], { after: cursor });
						for (const event of page.events)
							out(
								`Event: ${event.type}\nRevision: ${event.revision}\nCursor: ${event.cursor.journal_id}:${event.cursor.seq}\n`,
							);
						cursor = page.cursor;
						current = await bridge.snapshot(null, positional[0]);
						if (current.run.revision !== printedRevision && cursor.seq === current.cursor.seq) {
							printRun(current.run, out);
							printedRevision = current.run.revision;
						}
						// Node transitions are the progress a watcher actually wants; print them
						// even when no Run-level transition landed in this page.
						const now = progress(current.run.state);
						if (now?.nodes.length) lastNodes = printNodes(now.nodes, now.omitted || undefined, out, lastNodes);
						if (!page.next_cursor && !isTerminal(current.run.state)) {
							await Bun.sleep(1000);
						}
					}
					if (current.run.state === "unknown")
						throw new CliError("result_unknown", "Graph Run outcome is unknown");
				}
				return 0;
			} finally {
				observation?.close();
			}
		}
		if (action === "host.ensure") {
			throw new CliError(
				"capability_unavailable",
				"Standalone Graph worker is unavailable: trusted host configuration for authorization, revocation and process containment is not configured",
			);
		}
		store = new GraphAuthoringService(limits, options.root);
		if (action === "request.get") {
			const result = store.requestGetAuthorized(positional[0], options.authorizeExecutionReceipt);
			if (!result) throw new CliError("unknown_reference", "Request does not exist");
			if (json) printJson({ schema_version: 1, kind: "graph.operation", operation: result.receipt }, out);
			else {
				printOperation(
					result.receipt,
					out,
					false,
					result.kind === "publication" ? "Target" : result.kind === "execution" ? "Run" : "Graph",
				);
				if (result.kind === "publication" && result.receipt.result_ref)
					out(`Artifact: ${result.receipt.result_ref.id}@${result.receipt.result_ref.digest}\n`);
			}
			return 0;
		}
		if (action === "export" || action === "validate" || action === "preview") {
			const snapshot = store.get(positional[0]);
			if (!snapshot) throw new CliError("unknown_graph", "Graph does not exist");
			if (action === "export") {
				const output = flags.get("output") ?? "-";
				if (json) printJson({ schema_version: 1, kind: "graph.definition", ...snapshot }, out);
				else if (output === "-") out(snapshot.content);
				else if (options.writeOutput) options.writeOutput(output, snapshot.content);
				else fs.writeFileSync(output, snapshot.content);
			} else {
				const validation = validateGraphDefinition(snapshot.content, limits);
				if (json && action === "validate") {
					printJson(
						{
							schema_version: 1,
							kind: "graph.validation",
							graph_id: snapshot.graph_id,
							revision: snapshot.revision,
							issues: validation.issues,
						},
						out,
					);
					return validation.issues.length ? exitCode("definition_invalid") : 0;
				}
				if (validation.issues.length) throw new CliError("definition_invalid", JSON.stringify(validation.issues));
				if (action === "validate")
					out(`Graph: ${snapshot.graph_id}\nState: valid\nRevision: ${snapshot.revision}\n`);
				else {
					const graph = validation.source.frontmatter.frontmatter as unknown as GraphDefinition;
					out(renderGraphMermaid(graph));
				}
			}
			return 0;
		}
		const creating = action === "create" || action === "import";
		const requestKey =
			flags.get("request-key") ?? (action === "create" ? crypto.randomUUID() : requireFlag("request-key"));
		const revision = creating ? null : requireFlag("if-revision");
		let payload: Record<string, unknown>;
		if (action === "create") payload = { name: positional[0] };
		else if (action === "import" || action === "edit") {
			if (action === "import" && flags.has("template")) {
				if (flags.has("file")) fail("--template and --file are mutually exclusive");
				const template = await readGraphTemplate(
					requireFlag("template"),
					limits,
					options.templateRoot ? { root: options.templateRoot } : {},
				).catch((cause: unknown) => {
					throw new CliError(
						"unknown_reference",
						cause instanceof Error ? cause.message : "Unknown Graph template",
					);
				});
				payload = { content: await Bun.file(template.path).text() };
			} else if (action === "import" && !flags.has("file")) fail("import requires --file or --template");
			else payload = { content: await readFile() };
		} else {
			let parsed: StrictFrontmatter;
			try {
				parsed = parseStrictFrontmatter(await readFile(), limits);
			} catch (error) {
				if (error instanceof CliError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new CliError(
					/(?:exceeds .*limit|alias count|excessive alias)/i.test(message)
						? "resource_limit"
						: "definition_invalid",
					message,
				);
			}
			payload =
				action === "member.add" || action === "node.add"
					? { key: positional[1], value: parsed.frontmatter, body: parsed.body }
					: { value: parsed.frontmatter };
		}
		if (!json && action === "create" && !flags.has("request-key")) out(`Request: ${requestKey}\n`);
		const request: GraphMutation = {
			version: 1,
			operation: action as GraphMutation["operation"],
			request_key: requestKey,
			target_id: creating ? null : positional[0],
			if_revision: revision,
			payload,
		};
		const result = store.mutate(request);
		if (json) printJson({ schema_version: 1, kind: "graph.operation", operation: result }, out);
		else printOperation(result, out, action === "create" && !flags.has("request-key"));
		return result.error ? exitCode(result.error.code) : 0;
	} catch (error) {
		const code =
			error instanceof GraphObservationBridgeError
				? error.code === "scope_denied"
					? "permission_denied"
					: "internal_error"
				: error instanceof GraphObservationError ||
					  error instanceof CliError ||
					  error instanceof GraphAnswerError ||
					  error instanceof GraphTextPublicationError
					? error.code
					: error instanceof Error &&
						  "code" in error &&
						  typeof error.code === "string" &&
						  [
								"permission_denied",
								"model_unavailable",
								"base_unavailable",
								"capability_unavailable",
								"resource_limit",
								"budget_exhausted",
								"gate_unsatisfied",
								"input_stale",
								"unknown_reference",
								"question_closed",
								"revision_conflict",
								"idempotency_conflict",
								"source_unavailable",
								"internal_error",
						  ].includes(error.code)
						? error.code
						: error instanceof Error && /(?:exceeds .*limit|alias count|excessive alias)/i.test(error.message)
							? "resource_limit"
							: error instanceof Error && "pos" in error
								? "definition_invalid"
								: "internal_error";
		const message = error instanceof Error ? error.message : String(error);
		if (json)
			printJson(
				{
					schema_version: 1,
					kind: "graph.error",
					error: {
						code,
						message:
							message.length > 4096 ? "Graph command failed; error message exceeds JSON output limit" : message,
						location: null,
						retryable: false,
						details: null,
					},
				},
				out,
			);
		else err(`Reason: ${code}: ${message}\n`);
		return exitCode(code);
	} finally {
		store?.close();
	}
}

function isTerminal(state: GraphRunSummary["state"]): boolean {
	return isTerminalRunState(state);
}

function printRun(run: GraphRunSummary, out: (text: string) => void): void {
	out(
		`Run: ${run.id}\nGraph: ${run.graph_id}\nState: ${run.state}\nRevision: ${run.revision}\nDefinition revision: ${run.definition_revision}\n`,
	);
	// A held Run is only actionable if the operator can tell which kind of pause it is.
	if (run.state === "held")
		out(
			run.hold_kind === "operator"
				? `Hold: operator pause\nNext: omp graph resume ${run.id} --if-revision ${run.revision} --request-key <key>\n`
				: run.hold_kind === "gate"
					? `Hold: decision gate\nNext: omp graph resume ${run.id} --decision-ref <ID@DIGEST> --if-revision ${run.revision} --request-key <key>\n`
					: `Hold: reconciliation required\nNext: stop the executor, then omp graph recover ${run.id} --reason <how you verified it stopped>\n`,
		);
	const usage = run.observed_bot_usage;
	if (usage)
		out(
			`Observed Bot cost (USD): ${usage.cost_usd ?? "unknown"}\nObserved Bot usage: ${usage.completeness}; ${usage.observed_sources} source(s); excludes unobserved jobs and non-Bot costs\n`,
		);
}

/**
 * Print node progress lines. With `previous`, only changed nodes print, so a follower
 * sees transitions instead of the whole table every second. Returns the new snapshot.
 */
function printNodes(
	nodes: readonly GraphRunNodeProgress[],
	omitted: number | undefined,
	out: (text: string) => void,
	previous?: Map<string, GraphRunNodeProgress["state"]>,
): Map<string, GraphRunNodeProgress["state"]> {
	const seen = previous ?? new Map<string, GraphRunNodeProgress["state"]>();
	for (const node of nodes) {
		if (seen.get(node.node) === node.state) continue;
		seen.set(node.node, node.state);
		out(`${formatNodeProgressLine(node)}\n`);
	}
	if (omitted) out(`Node progress omitted: ${omitted}\n`);
	return seen;
}

function printOperation(
	result: GraphOperation,
	out: (text: string) => void,
	skipRequest = false,
	target = "Graph",
): void {
	const lines = [
		skipRequest ? null : `Request: ${result.request_key}`,
		result.target_id ? `${target}: ${result.target_id}` : null,
		`State: ${result.state}`,
		result.revision ? `Revision: ${result.revision}` : null,
		result.error ? `Reason: ${result.error.code}: ${result.error.message}` : null,
	];
	out(`${lines.filter(line => line !== null).join("\n")}\n`);
}
