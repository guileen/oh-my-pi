import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import type { GraphDefinition, GraphNode } from "./contracts";
import type { SchedulerInvocation } from "./scheduler";

/** Parent output name -> exact child node/output. Never infer exports from matching names. */
export type ChildOutputBindings = Record<string, { node: string; output: string }>;

export function validateChildOutputBindings(
	parent: GraphNode,
	child: GraphDefinition,
	bindings: ChildOutputBindings,
): void {
	if (!bindings || typeof bindings !== "object" || Array.isArray(bindings))
		throw new Error("Invalid child output bindings");
	for (const [name, binding] of Object.entries(bindings)) {
		const target = Object.hasOwn(parent.outputs ?? {}, name) ? parent.outputs![name] : undefined;
		if (
			!target ||
			!binding ||
			typeof binding !== "object" ||
			Array.isArray(binding) ||
			Object.keys(binding).length !== 2 ||
			typeof binding.node !== "string" ||
			typeof binding.output !== "string" ||
			!Object.hasOwn(child.nodes, binding.node)
		)
			throw new Error(`Invalid child output binding '${name}'`);
		const outputs = child.nodes[binding.node].outputs ?? {};
		const source = Object.hasOwn(outputs, binding.output) ? outputs[binding.output] : undefined;
		if (
			!source ||
			source.media_type !== target.media_type ||
			(target.schema_ref &&
				(source.schema_ref?.id !== target.schema_ref.id || source.schema_ref.digest !== target.schema_ref.digest))
		)
			throw new Error(`Incompatible child output binding '${name}'`);
	}
	for (const [name, output] of Object.entries(parent.outputs ?? {}))
		if (output.required && !Object.hasOwn(bindings, name))
			throw new Error(`Missing required child output binding '${name}'`);
}

/** Resolve scheduler-owned candidates only. These refs do not prove artifact availability,
 * read permission, schema validity or integrated acceptance; the trusted host must verify those. */
export function resolveChildOutputCandidates(
	bindings: ChildOutputBindings,
	invocations: readonly SchedulerInvocation[],
): Record<string, GraphRef> | null {
	const current = invocations.filter(item => !item.superseded);
	if (
		current.some(item =>
			item.consultation
				? !["succeeded", "failed", "cancelled"].includes(item.state)
				: !["succeeded", "skipped"].includes(item.state),
		)
	)
		return null;
	const outputs: Record<string, GraphRef> = {};
	for (const [name, binding] of Object.entries(bindings)) {
		const matches = current.filter(item => !item.consultation && item.node === binding.node);
		const source = matches.length === 1 ? matches[0] : undefined;
		if (!source || source.state !== "succeeded" || !source.attempt_id || source.origin === "imported") return null;
		const ref = Object.hasOwn(source.outputs ?? {}, binding.output) ? source.outputs![binding.output] : undefined;
		if (!ref || typeof ref.id !== "string" || !ref.id || typeof ref.digest !== "string" || !ref.digest) return null;
		Object.defineProperty(outputs, name, { value: { id: ref.id, digest: ref.digest }, enumerable: true });
	}
	return outputs;
}
