import type {
	GraphNotification,
	GraphObservedUsage,
	GraphRef,
	GraphRunDeliverable,
	GraphRunState,
} from "@oh-my-pi/pi-wire/graph";
import type { GraphArtifact } from "./artifacts";
import { type GraphCatalogContract, readDeclaredContract } from "./contract-meta";
import { GraphObservation, isTerminalRunState, resolveDeliverableReadiness } from "./observation";
import type { GraphScheduleState } from "./store";

export const GRAPH_REPORT_FORMAT = "omp.graph/report/v1" as const;

/** Human deliverable for one Run, judged from committed facts only. Never an acceptance. */
export interface GraphReport {
	format: typeof GRAPH_REPORT_FORMAT;
	run_id: string;
	graph_id: string;
	graph_name: string | null;
	title: string | null;
	state: GraphRunState;
	deliverable: (GraphRunDeliverable & { summary: string | null; experience: string | null }) | null;
	artifacts: GraphReportArtifact[];
	observed_bot_usage: GraphObservedUsage | null;
	/** Newest notifications for this Run, oldest-first. */
	notifications: GraphNotification[];
	/** Facts a dispatcher should act on; none of them starts work. */
	next_actions: string[];
}

export interface GraphReportArtifact {
	/** Declared deliverable output name this artifact satisfies. */
	name: string;
	node: string;
	output: string;
	digest: string;
	media_type: string | null;
	size_bytes: number;
	/** Bounded text prefix; `null` for non-text artifacts or an unreadable object. */
	preview: string | null;
	truncated: boolean;
	/** Why the content is absent; `null` when `preview` carries it. */
	unavailable: string | null;
}

export interface GraphReportOptions {
	/** Trusted host read. It MUST apply its own artifact authorization; a ref is not a grant. */
	readArtifact(ref: GraphRef): Promise<{ artifact: GraphArtifact; bytes: Uint8Array }>;
	/** Characters of decoded text shown per artifact. Default 1200, at most 8000. */
	previewChars?: number;
	/** Lines of decoded text shown per artifact. Default 24, at most 100. */
	previewLines?: number;
	/** Newest notifications included. Default 5, at most 50. */
	notificationLimit?: number;
}

const TEXTUAL = /^(text\/|application\/(json|ndjson|yaml|x-yaml|xml|toml|sql|javascript|typescript|x-sh))/;
const TEXTUAL_SUFFIX = /\+(json|xml)$/;

function isTextual(mediaType: string | null): boolean {
	if (!mediaType) return false;
	const normalized = mediaType.split(";")[0]!.trim().toLowerCase();
	return TEXTUAL.test(normalized) || TEXTUAL_SUFFIX.test(normalized);
}

/** Bound the preview; a report is read by a human, not piped into another process. */
function preview(bytes: Uint8Array, chars: number, lines: number): { text: string; truncated: boolean } {
	const truncatedBytes = bytes.byteLength > chars * 4;
	const decoded = new TextDecoder().decode(truncatedBytes ? bytes.subarray(0, chars * 4) : bytes);
	const all = decoded.split("\n");
	let text = all.slice(0, lines).join("\n");
	let truncated = truncatedBytes || all.length > lines;
	if (text.length > chars) {
		text = text.slice(0, chars);
		truncated = true;
	}
	return { text: text.trimEnd(), truncated };
}

/**
 * Resolve declared deliverable artifacts to the exact outputs a non-superseded invocation
 * produced. A declared name with no committed output is `missing`, never borrowed from a
 * different attempt: the report must not present superseded work as the hand-off.
 */
function resolveRefs(
	contract: GraphCatalogContract,
	schedule: GraphScheduleState,
	names: readonly string[],
): { name: string; node: string; output: string; ref: GraphRef }[] {
	const resolved: { name: string; node: string; output: string; ref: GraphRef }[] = [];
	for (const name of names) {
		const declared = contract.outputs.find(output => output.name === name);
		if (!declared?.node || !declared.output) continue;
		for (const invocation of schedule.invocations) {
			if (invocation.node !== declared.node || invocation.superseded) continue;
			const ref = invocation.outputs?.[declared.output];
			if (!ref) continue;
			resolved.push({ name, node: declared.node, output: declared.output, ref });
			break;
		}
	}
	return resolved;
}

export async function buildGraphReport(
	observation: GraphObservation,
	runId: string,
	options: GraphReportOptions,
): Promise<GraphReport> {
	const snapshot = observation.snapshot(runId);
	const run = snapshot.run;
	const contract = (() => {
		const definition = observation.getFrozenDefinition(runId);
		return definition ? readDeclaredContract(definition) : null;
	})();
	const schedule = observation.getScheduleState(runId);
	const readiness = contract ? resolveDeliverableReadiness(contract, schedule) : undefined;
	const declared = contract?.deliverable ?? null;
	const chars = Math.min(Math.max(options.previewChars ?? 1200, 1), 8000);
	const lines = Math.min(Math.max(options.previewLines ?? 24, 1), 100);

	const artifacts: GraphReportArtifact[] = [];
	if (contract && declared && schedule) {
		const outputs = contract.outputs;
		for (const candidate of resolveRefs(contract, schedule, declared.artifacts)) {
			const output = outputs.find(item => item.name === candidate.name);
			const base = {
				name: candidate.name,
				node: candidate.node,
				output: candidate.output,
				digest: candidate.ref.digest,
			};
			try {
				const { artifact, bytes } = await options.readArtifact(candidate.ref);
				const text = isTextual(artifact.media_type);
				const bounded = text ? preview(bytes, chars, lines) : null;
				artifacts.push({
					...base,
					media_type: artifact.media_type,
					size_bytes: artifact.size_bytes,
					preview: bounded?.text ?? null,
					truncated: bounded?.truncated ?? false,
					unavailable: text ? null : "not a text artifact",
				});
			} catch (error) {
				artifacts.push({
					...base,
					media_type: output?.media_type ?? null,
					size_bytes: 0,
					preview: null,
					truncated: false,
					unavailable:
						error && typeof error === "object" && "code" in error && typeof error.code === "string"
							? error.code
							: "unknown",
				});
			}
		}
	}

	const page = observation.notifications({
		since: 0,
		limit: Math.min(Math.max(options.notificationLimit ?? 5, 1), 50),
		run_id: runId,
		latest: true,
	});

	const next_actions: string[] = [];
	if (!isTerminalRunState(run.state)) next_actions.push("Run is not terminal; `wait` rather than polling status.");
	if (run.state === "held")
		next_actions.push(`Held (${run.hold_kind ?? "gate"}); resuming needs its matching authorization.`);
	if (readiness && !readiness.ready) next_actions.push(`Deliverable incomplete: ${readiness.missing.join(", ")}.`);
	if (readiness?.ready)
		next_actions.push("Deliverable artifacts are all produced; this is an observation, not an acceptance.");
	if (artifacts.some(artifact => artifact.unavailable))
		next_actions.push("Some artifact content is unavailable; the list shows metadata only.");
	if (next_actions.length === 0 && isTerminalRunState(run.state))
		next_actions.push("No further graph action implied.");

	return {
		format: GRAPH_REPORT_FORMAT,
		run_id: run.id,
		graph_id: run.graph_id,
		graph_name: run.graph_name ?? null,
		title: run.title ?? null,
		state: run.state,
		deliverable:
			declared && readiness ? { ...readiness, summary: declared.summary, experience: declared.experience } : null,
		artifacts,
		observed_bot_usage: run.observed_bot_usage ?? null,
		notifications: page.notifications,
		next_actions: next_actions.slice(0, 3),
	};
}

/** Short, human-first rendering. Long content stays in the artifacts. */
export function renderGraphReportText(report: GraphReport): string {
	const lines = [`${report.title ?? report.graph_name ?? "Graph Run"} — ${report.state}`, `Run: ${report.run_id}`];
	if (report.deliverable) {
		const { ready, missing, summary, experience } = report.deliverable;
		lines.push(`Deliverable: ${ready ? "ready" : `pending (${missing.join(", ")})`}`);
		if (summary) lines.push(`Summary: ${summary}`);
		if (experience) lines.push(`Try it: ${experience}`);
	} else lines.push("Deliverable: not declared");
	if (report.observed_bot_usage)
		lines.push(
			`Observed Bot cost (USD): ${report.observed_bot_usage.cost_usd ?? "unknown"} (${report.observed_bot_usage.completeness})`,
		);
	if (report.artifacts.length) {
		lines.push("Artifacts:");
		for (const artifact of report.artifacts) {
			const media = artifact.media_type ?? "unknown type";
			lines.push(`- ${artifact.name}  ${artifact.size_bytes} B  ${media}  ${artifact.digest.slice(0, 19)}…`);
			if (artifact.preview) {
				for (const line of artifact.preview.split("\n")) lines.push(`    ${line}`);
				if (artifact.truncated) lines.push("    …");
			} else lines.push(`    (no preview: ${artifact.unavailable ?? "empty"})`);
		}
	}
	if (report.notifications.length)
		lines.push(
			...report.notifications.map(
				notification => `Notification: ${notification.kind}  ${notification.state}  ${notification.occurred_at}`,
			),
		);
	if (report.next_actions.length) lines.push(...report.next_actions.map(action => `Next: ${action}`));
	return lines.join("\n");
}
