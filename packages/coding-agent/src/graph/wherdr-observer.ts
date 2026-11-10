import { readProfileArtifact } from "./artifacts";
import { GraphObservation } from "./observation";
import { GraphObservationBridge } from "./observation-bridge";
import { GraphObservationRootError, resolveGraphObservationRoot } from "./read-profile";
import { buildGraphReport } from "./report";

// Invoked only by a trusted local embedding. The caller MUST authorize the exact Run
// before launch; neither this process nor profile access constitutes authorization.
const root = process.argv[2];
const limits = { maxBytes: 1024 * 1024, maxDepth: 64, maxAliases: 100, maxNodes: 10000 };
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const SECONDARY_KEYS = ["history", "extensions", "report", "descriptor"] as const;
const REPORT_KEYS = { preview_chars: 8000, preview_lines: 100, notification_limit: 50 } as const;

try {
	if (!root || process.argv.length !== 3) throw new Error("invalid configuration");
	const input = JSON.parse(await Bun.stdin.text());
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid input");
	const keys = Object.keys(input);
	const secondary = keys.filter(key => key !== "run_id");
	if (
		!Object.hasOwn(input, "run_id") ||
		typeof input.run_id !== "string" ||
		!RUN_ID.test(input.run_id) ||
		secondary.length > 1 ||
		secondary.some(key => !(SECONDARY_KEYS as readonly string[]).includes(key))
	)
		throw new Error("invalid input");
	if (
		input.extensions !== undefined &&
		(!Array.isArray(input.extensions) ||
			input.extensions.length > 32 ||
			!input.extensions.every(
				(extension: unknown) => typeof extension === "string" && /^[a-z][a-z0-9.-]{0,127}$/.test(extension),
			) ||
			new Set(input.extensions).size !== input.extensions.length)
	)
		throw new Error("invalid input");
	if (input.history !== undefined) {
		const history = input.history;
		const validCursor = (cursor: unknown): boolean => {
			if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return false;
			const value = cursor as Record<string, unknown>;
			return (
				Object.keys(value).length === 2 &&
				typeof value.journal_id === "string" &&
				RUN_ID.test(value.journal_id) &&
				typeof value.seq === "string" &&
				/^(0|[1-9][0-9]*)$/.test(value.seq)
			);
		};
		if (
			!history ||
			typeof history !== "object" ||
			Array.isArray(history) ||
			Object.keys(history).some(key => !["after", "watermark", "limit"].includes(key)) ||
			(history.after !== undefined && !validCursor(history.after)) ||
			(history.watermark !== undefined && !validCursor(history.watermark)) ||
			(history.limit !== undefined &&
				(!Number.isSafeInteger(history.limit) || history.limit < 1 || history.limit > 100))
		)
			throw new Error("invalid input");
	}
	let reportRequest: { previewChars?: number; previewLines?: number; notificationLimit?: number } | null = null;
	if (input.descriptor !== undefined && input.descriptor !== true) throw new Error("invalid input");
	if (input.report !== undefined) {
		const request = input.report;
		if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("invalid input");
		const bounds = REPORT_KEYS as Record<string, number>;
		const options: { previewChars?: number; previewLines?: number; notificationLimit?: number } = {};
		for (const key of Object.keys(request)) {
			const maximum = bounds[key];
			const value = (request as Record<string, unknown>)[key];
			if (
				maximum === undefined ||
				!Number.isSafeInteger(value) ||
				(value as number) < 1 ||
				(value as number) > maximum
			)
				throw new Error("invalid input");
			options[
				key === "preview_chars" ? "previewChars" : key === "preview_lines" ? "previewLines" : "notificationLimit"
			] = value as number;
		}
		reportRequest = options;
	}
	const observedRoot = resolveGraphObservationRoot(root);
	const observation = new GraphObservation(observedRoot, limits);
	try {
		const bridge = new GraphObservationBridge(observation, (_principal: null, id) => id === input.run_id);
		const payload = async (): Promise<unknown> => {
			if (input.descriptor === true) {
				// A reference only: the observer never reads the descriptor body, so a reachable
				// reference cannot become publication authority.
				return { start_descriptor: observation.getStartDescriptor(input.run_id) };
			}
			if (reportRequest !== null) {
				return {
					report: await buildGraphReport(observation, input.run_id, {
						...reportRequest,
						// A report only reads; the grant never widens into publication authority.
						readArtifact: ref =>
							readProfileArtifact(ref, {
								root: observedRoot,
								maxBytes: limits.maxBytes,
								principal: "wherdr-observer",
								authorize: async (_principal, action) => action === "read",
							}),
					}),
				};
			}
			if (input.extensions !== undefined)
				return { extensions: await bridge.extensions(null, input.run_id, input.extensions) };
			if (input.history !== undefined) return bridge.viewHistory(null, input.run_id, input.history);
			return bridge.view(null, input.run_id);
		};
		console.log(JSON.stringify(await payload()));
	} finally {
		observation.close();
	}
} catch (error) {
	// Do not disclose filesystem paths or protected data in errors.
	console.error(
		error instanceof GraphObservationRootError
			? "Graph observation unavailable (ambiguous_root)"
			: "Graph observation unavailable",
	);
	process.exitCode = 1;
}
