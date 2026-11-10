import type { GraphRef } from "@oh-my-pi/pi-wire/graph";

/**
 * A trusted host must enumerate the complete protected trees (including added and
 * deleted files), not just files mentioned by the graph. Symlinks are represented
 * by their link text; mode and kind are part of the digest. Capture must be taken
 * from a stable, isolated view, or changes between enumeration and reading can be
 * missed. These types do not themselves create an OS sandbox.
 */
export interface IntegrationEntry {
	path: string;
	kind: "file" | "symlink" | "directory";
	mode: number;
	content: Uint8Array;
}
export interface IntegrationSnapshot {
	source: readonly IntegrationEntry[];
	specification: readonly IntegrationEntry[];
	upstream: readonly IntegrationEntry[];
}
export interface IntegrationVersion {
	source: string;
	specification: string;
	upstream: string;
}
export interface FrozenIntegration {
	version: IntegrationVersion;
	sourceRevision: string;
	integrator: string;
	changeRiskMap: GraphRef;
}

function digestEntries(entries: readonly IntegrationEntry[], required: boolean): string {
	if (required && !entries.length) throw new Error("Protected snapshot is empty");
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const hash = new Bun.CryptoHasher("sha256");
	let previous: string | undefined;
	for (const entry of sorted) {
		if (
			!entry.path ||
			entry.path.startsWith("/") ||
			/[\\\x00-\x1f]/.test(entry.path) ||
			entry.path.split("/").some(part => !part || part === "." || part === "..") ||
			entry.path === previous ||
			(entry.kind !== "file" && entry.kind !== "symlink" && entry.kind !== "directory") ||
			!Number.isSafeInteger(entry.mode) ||
			entry.mode < 0 ||
			!(entry.content instanceof Uint8Array)
		)
			throw new Error("Invalid protected snapshot entry");
		previous = entry.path;
		// JSON framing includes the byte length, so neither names nor contents can
		// make two distinct manifests hash to the same concatenation.
		hash.update(JSON.stringify([entry.path, entry.kind, entry.mode, entry.content.byteLength]));
		hash.update("\n");
		hash.update(entry.content);
	}
	return `sha256:${hash.digest("hex")}`;
}

export function integrationVersion(snapshot: IntegrationSnapshot): IntegrationVersion {
	return {
		source: digestEntries(snapshot.source, true),
		specification: digestEntries(snapshot.specification, true),
		upstream: digestEntries(snapshot.upstream, false),
	};
}

/** Called only after the trusted integrator has atomically assembled the version. */
export function freezeIntegration(
	snapshot: IntegrationSnapshot,
	handoff: Omit<FrozenIntegration, "version">,
): FrozenIntegration {
	if (
		!handoff.integrator ||
		!handoff.sourceRevision ||
		!handoff.changeRiskMap.id ||
		!/^sha256:[0-9a-f]{64}$/.test(handoff.changeRiskMap.digest)
	)
		throw new Error("Incomplete integration handoff");
	return { ...structuredClone(handoff), version: integrationVersion(snapshot) };
}

export interface AcceptanceRequest {
	tester: string;
	command: string;
	scenario: string;
	environment: string;
}
export interface AcceptanceEvidence {
	request: AcceptanceRequest;
	version: IntegrationVersion;
	status: "passed" | "failed" | "hold";
	reason: string;
	/** The host's actual isolation disclosure, not a sandbox claim inferred from a role. */
	isolation: string;
	observed?: string;
}
export interface AcceptanceExecutionReceipt {
	id: string;
	evidence: AcceptanceEvidence;
	revision: string;
}

/** Created durably before authorization or execution; never reconstructed from a PID. */
export interface AcceptanceExecutionIdentity {
	run_id: string;
	execution_id: string;
	freeze_id: string;
}
export interface RecordedAcceptanceExecution {
	identity: AcceptanceExecutionIdentity;
	request: AcceptanceRequest;
	frozen: FrozenIntegration;
	isolation: string;
	state: "active" | "unknown";
}
/**
 * Trusted embedding input, NOT a proof verified by the graph store. The embedding
 * must resolve its durable execution binding and confirm all effects covered by
 * that execution have stopped before submitting this observation. A reference,
 * callback, leader exit, PID probe or timeout alone cannot establish that fact.
 * Recovery only retires the pending execution; it never certifies a passing test.
 */
export interface AcceptanceExecutionStopped {
	identity: AcceptanceExecutionIdentity;
	termination_ref: GraphRef;
	observed: string;
}
export interface AcceptanceHost {
	/** Trusted host checks test-only duty, identity, command and independent context. */
	authorize(request: AcceptanceRequest, frozen: FrozenIntegration): Promise<boolean>;
	/** True only when the configured executor actually enforces source isolation. */
	sourceIsolation: boolean;
	isolationDescription: string;
	/** Trusted explicit authorization of the disclosed lack of enforcement. */
	authorizeIsolationLimitation?(request: AcceptanceRequest, frozen: FrozenIntegration): Promise<boolean>;
	capture(): Promise<IntegrationSnapshot>;
	/** Resolve only after the configured execution terminates; reject if termination is unconfirmed.
	 * Any descendant containment limitations remain part of the host's isolation disclosure. */
	run(
		request: AcceptanceRequest,
		/** Store-backed execution supplies this durable identity to recovery-capable hosts.
		 * Bind it to the external execution before launching; standalone calls omit it. */
		identity?: AcceptanceExecutionIdentity,
	): Promise<{ success: boolean; observed: string }>;
}

function sameVersion(a: IntegrationVersion, b: IntegrationVersion): boolean {
	return a.source === b.source && a.specification === b.specification && a.upstream === b.upstream;
}

/** Only successful, version-matching independent acceptance is applicable. */
export function acceptanceApplies(evidence: AcceptanceEvidence, current: IntegrationVersion): boolean {
	return evidence.status === "passed" && sameVersion(evidence.version, current);
}

/**
 * The capture and run callbacks are trusted host capabilities, not graph input.
 * Callers must persist the result and guard the frozen version transactionally at
 * the delivery gate. Capturing before/after alone cannot detect transient writes.
 */
export async function runFrozenAcceptance(
	frozen: FrozenIntegration,
	request: AcceptanceRequest,
	host: AcceptanceHost,
): Promise<AcceptanceEvidence> {
	frozen = structuredClone(frozen);
	request = structuredClone(request);
	const result: AcceptanceEvidence = {
		request,
		version: frozen.version,
		status: "hold",
		reason: "",
		isolation: host.isolationDescription,
	};
	if (!request.tester || !request.command || !request.scenario || !request.environment || !host.isolationDescription) {
		result.reason = "Incomplete acceptance request or isolation disclosure";
		return result;
	}
	try {
		if ((await host.authorize(structuredClone(request), structuredClone(frozen))) !== true) {
			result.reason = "Test-only execution is not authorized";
			return result;
		}
		if (
			host.sourceIsolation !== true &&
			(await host.authorizeIsolationLimitation?.(structuredClone(request), structuredClone(frozen))) !== true
		) {
			result.reason = "Source isolation is not enforced and its limitation is not authorized";
			return result;
		}
		if (!sameVersion(integrationVersion(await host.capture()), frozen.version)) {
			result.reason = "Protected version differs from frozen handoff before execution";
			return result;
		}
		let execution: { success: boolean; observed: string } | undefined;
		let error: unknown;
		try {
			const reported = await host.run(structuredClone(request));
			execution = { success: reported.success, observed: reported.observed };
		} catch (caught) {
			error = caught;
		}
		if (!sameVersion(integrationVersion(await host.capture()), frozen.version)) {
			result.reason = "Protected source, specification, or upstream artifacts changed during acceptance";
			result.observed = execution?.observed;
			return result;
		}
		if (error !== undefined || !execution || execution.success !== true || !execution.observed) {
			result.status = "failed";
			result.reason =
				error !== undefined
					? `Test execution failed: ${String(error)}`
					: "Test did not produce passing observed evidence";
			result.observed = execution?.observed;
			return result;
		}
		result.status = "passed";
		result.reason = "Independent test completed against the frozen version";
		result.observed = execution.observed;
		return result;
	} catch (error) {
		result.reason = `Acceptance could not be authorized or protected version could not be captured: ${String(error)}`;
		return result;
	}
}
