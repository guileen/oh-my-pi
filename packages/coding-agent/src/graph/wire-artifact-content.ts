import type { Database } from "bun:sqlite";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import { GraphWireError, type GraphRef, type GraphWireRecord } from "@oh-my-pi/pi-wire/graph";
import { graphWireRecordKey, validateGraphWireRecord } from "@oh-my-pi/pi-wire/graph/wire-records";
import { ArtifactError, type ArtifactAvailability, type LocalArtifactStore } from "./artifacts";

export interface GraphWireArtifactContent {
	availability: ArtifactAvailability;
	media_type: string | null;
	content: string | null;
}

export interface GraphWireArtifactContentOptions {
	/** Trusted host-owned store: its read method verifies immutable bytes and current artifact grants. */
	artifacts: Pick<LocalArtifactStore, "read">;
	principal: string;
	/** Maximum complete UTF-8 response, not a truncation or pagination limit. */
	maxBytes: number;
}

const unavailable = (availability: ArtifactAvailability = "unknown"): GraphWireArtifactContent => ({
	availability,
	media_type: null,
	content: null,
});
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const ref = (value: unknown): value is GraphRef =>
	object(value) &&
	typeof value.id === "string" &&
	typeof value.digest === "string" &&
	/^sha256:[0-9a-f]{64}$/.test(value.digest);
function denied(): never {
	throw new GraphWireError("scope_denied", "Protected Graph content is outside the requested scope");
}
const textMediaType = (value: string): boolean => {
	const [type, ...parameters] = value
		.toLowerCase()
		.split(";")
		.map(part => part.trim());
	return (
		!!type &&
		/^(text\/[a-z0-9!#$&^_.+-]+|application\/(json|[a-z0-9!#$&^_.+-]+\+json))$/.test(type) &&
		parameters.every(parameter => /^charset\s*=\s*("utf-8"|utf-8)$/.test(parameter))
	);
};

/** Read-only registry projection. Never opens a writer, installs schema, or returns protected
 * snapshots/configuration. A published name and a trusted stored input/output digest are both
 * required; neither a registry entry nor a reference name alone grants access. The bridge owns
 * source/Run authorization before and after this asynchronous read. */
export class GraphWireArtifactContentReader {
	constructor(
		private readonly db: Database,
		private readonly options: GraphWireArtifactContentOptions,
	) {
		if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > 1024 * 1024)
			throw new GraphWireError("invalid_input", "Invalid Graph artifact content bound");
	}

	async read(sourceId: string, runId: string, contentRef: string): Promise<GraphWireArtifactContent> {
		try {
			const resolved = this.db.transaction(() => this.#resolve(sourceId, runId, contentRef))();
			if (!resolved) return unavailable();
			const { reference, mediaType, size } = resolved;
			if (mediaType !== null && (!textMediaType(mediaType) || size === null || size > this.options.maxBytes))
				return unavailable();
			const bytes = await this.options.artifacts.read(this.options.principal, reference);
			if (mediaType === null || bytes.byteLength > this.options.maxBytes || bytes.byteLength !== size)
				return unavailable();
			const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			// Valid UTF-8 alone does not make NUL-bearing binary a text response.
			if (content.includes("\0")) return unavailable();
			const current = this.db.transaction(() => this.#resolve(sourceId, runId, contentRef))();
			if (
				!current ||
				current.reference.id !== reference.id ||
				current.reference.digest !== reference.digest ||
				current.mediaType !== mediaType ||
				current.size !== size
			)
				return unavailable();
			return { availability: "available", media_type: mediaType, content };
		} catch (error) {
			if (error instanceof GraphWireError && error.code === "scope_denied") throw error;
			if (error instanceof ArtifactError) {
				if (error.code === "permission_denied") denied();
				if (error.code === "missing" || error.code === "expired") return unavailable(error.code);
			}
			// Digest failures, unsupported encodings, malformed storage and I/O failures are not content.
			return unavailable();
		}
	}

	#resolve(
		sourceId: string,
		runId: string,
		contentRef: string,
	): {
		reference: GraphRef;
		mediaType: string | null;
		size: number | null;
	} | null {
		const runKey = canonicalJson(["run", runId]);
		const runRow = this.db
			.query(`SELECT c.data FROM graph_wire_current c
			JOIN graph_wire_sources s ON s.source_id=c.source_id
			WHERE c.source_id=? AND c.run_id=? AND c.kind='run' AND c.record_key=?`)
			.get(sourceId, runId, runKey) as { data: string } | null;
		if (!runRow) denied();
		const run: unknown = JSON.parse(runRow.data);
		validateGraphWireRecord(run);
		if (run.kind !== "run" || run.value.graph_run_id !== runId || graphWireRecordKey(run) !== runKey) return null;

		// Query only explicit public artifact-bearing fields, never arbitrary nested reference strings.
		const rows = this.db
			.query(`WITH records AS (
			SELECT record_key, CASE WHEN json_valid(data) THEN data ELSE '{}' END AS data
			FROM graph_wire_current WHERE source_id=? AND run_id=?
			AND kind IN ('binding','dependency','transfer','execution_invocation','execution_attempt'))
			SELECT record_key,data FROM records WHERE
			EXISTS (SELECT 1 FROM json_each(data,'$.value.evidence_refs') WHERE value=?) OR
			EXISTS (SELECT 1 FROM json_each(data,'$.value.input_refs') WHERE value=?) OR
			EXISTS (SELECT 1 FROM json_each(data,'$.value.evidence')
				WHERE json_extract(value,'$.ref')=? OR json_extract(value,'$.artifact_id')=?) OR
			json_extract(data,'$.value.artifact.ref')=? OR json_extract(data,'$.value.artifact.artifact_id')=? OR
			json_extract(data,'$.value.result_ref')=?`)
			.all(sourceId, runId, contentRef, contentRef, contentRef, contentRef, contentRef, contentRef, contentRef) as {
			record_key: string;
			data: string;
		}[];
		if (!rows.length) denied();
		const records: GraphWireRecord[] = [];
		for (const row of rows) {
			const record: unknown = JSON.parse(row.data);
			validateGraphWireRecord(record);
			if (record.value.graph_run_id !== runId || graphWireRecordKey(record) !== row.record_key) return null;
			records.push(record);
		}
		const scheduleRow = this.db.query("SELECT data FROM graph_schedule_states WHERE run_id=?").get(runId) as {
			data: string;
		} | null;
		if (!scheduleRow) return null;
		const schedule: unknown = JSON.parse(scheduleRow.data);
		if (!object(schedule) || !Array.isArray(schedule.invocations) || !schedule.invocations.every(object)) return null;
		const candidates: GraphRef[] = [];
		const add = (values: unknown) => {
			if (!object(values)) return;
			for (const value of Object.values(values)) if (ref(value) && value.id === contentRef) candidates.push(value);
		};
		for (const record of records) {
			switch (record.kind) {
				case "binding": {
					if (!record.value.evidence_refs.includes(contentRef)) break;
					const invocation = schedule.invocations.find(item => item.id === record.value.invocation_id);
					if (invocation?.attempt_id === record.value.binding_id) add(invocation.outputs);
					break;
				}
				case "execution_invocation": {
					if (!record.value.input_refs.includes(contentRef)) break;
					const invocation = schedule.invocations.find(item => item.id === record.value.invocation_id);
					if (invocation && object(invocation.ready)) add(invocation.ready.inputs);
					break;
				}
				case "execution_attempt": {
					if (record.value.result_ref !== contentRef) break;
					const invocation = schedule.invocations.find(item => item.id === record.value.invocation_id);
					if (invocation?.attempt_id === record.value.attempt_id) add(invocation.outputs);
					break;
				}
				case "dependency":
				case "transfer": {
					const evidence = record.kind === "dependency" ? record.value.evidence : [record.value.artifact];
					if (!evidence.some(item => item.ref === contentRef || item.artifact_id === contentRef)) break;
					add(schedule.run_inputs);
					for (const invocation of schedule.invocations) add(invocation.outputs);
					break;
				}
			}
		}
		if (!candidates.length) denied();
		const reference = candidates[0]!;
		if (candidates.some(candidate => candidate.digest !== reference.digest)) return null;
		const row = this.db.query("SELECT digest,data FROM graph_artifacts WHERE id=?").get(reference.id) as {
			digest: string;
			data: string;
		} | null;
		// Still delegate missing/expired/grant handling to the trusted LocalArtifactStore.read.
		if (!row) return { reference, mediaType: null, size: null };
		const artifact: unknown = JSON.parse(row.data);
		if (
			!object(artifact) ||
			artifact.id !== reference.id ||
			artifact.digest !== reference.digest ||
			row.digest !== reference.digest ||
			typeof artifact.media_type !== "string" ||
			!Number.isSafeInteger(artifact.size_bytes) ||
			(artifact.size_bytes as number) < 0
		)
			return null;
		return { reference, mediaType: artifact.media_type, size: artifact.size_bytes as number };
	}
}
