import type { GraphLifecyclePolicy } from "./store";

/**
 * Lifecycle policy for the local profile owner: the OS user who already owns
 * `graphs.sqlite` and the artifact directory.
 *
 * - `hold`/`cancel` are allowed on Runs in this profile.
 * - `resume` is allowed only for an `operator` pause that the same principal created;
 *   gate holds still require a resolved decision reference through the trusted
 *   `verifyResume` path, which this policy never satisfies.
 *
 * `authorize` runs inside the store transaction and MUST NOT open a second store
 * connection: the store itself resolves the Run and reports `unknown_reference`,
 * while the profile owner already holds every Run in this root.
 *
 * Embedded hosts (RPC, web, workers) MUST build their own principal-scoped policy
 * instead of reusing this function.
 */
export function createLocalLifecyclePolicy(config: { principal?: string } = {}): GraphLifecyclePolicy {
	const principal = config.principal ?? "local-user";
	return {
		authorize: (who, request) =>
			who === principal &&
			(request.operation === "hold" || request.operation === "resume" || request.operation === "cancel"),
		verifyResume: (who, request, context) =>
			who === principal &&
			"kind" in request.payload &&
			request.payload.kind === "operator" &&
			context.run.state === "held" &&
			context.run.hold_kind === "operator" &&
			context.run.held_by === principal,
	};
}
