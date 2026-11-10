import type { GraphDefinition } from "./contracts";

/** Mermaid text is a projection only; execution always uses the validated definition. */
export function renderGraphMermaid(definition: GraphDefinition): string {
	const lines = ["flowchart LR"];
	const nodeIds = new Map(Object.keys(definition.nodes).map((key, index) => [key, `n${index}`]));
	const memberIds = new Map(Object.keys(definition.members).map((key, index) => [key, `m${index}`]));
	// Mermaid entity escapes prevent labels from terminating quoted strings or adding statements.
	const label = (value: string) =>
		value.replace(/[&#"<>]/g, char => `#${char.charCodeAt(0)};`).replace(/[\r\n]/g, " ");
	if (nodeIds.size) {
		lines.push('  subgraph tasks["Tasks"]');
		for (const [key, id] of nodeIds) {
			const node = definition.nodes[key];
			lines.push(`    ${id}["${label(key)} (${label(node.kind)})"]`);
		}
		lines.push("  end");
	}
	if (memberIds.size) {
		lines.push('  subgraph members["Members"]');
		for (const [key, id] of memberIds) lines.push(`    ${id}["${label(key)}"]`);
		lines.push("  end");
	}
	for (const edge of definition.edges ?? []) {
		const from = nodeIds.get(edge.from);
		const to = nodeIds.get(edge.to);
		if (!from || !to) throw new Error(`Unknown node in edge ${edge.id}`);
		const details = [edge.id, ...(edge.on ?? ["done"]), ...(edge.loop ? [`loop ${edge.loop}`] : [])].join(" / ");
		lines.push(`  ${from} -->|"${label(details)}"| ${to}`);
	}
	for (const [key, id] of nodeIds) {
		const member = definition.nodes[key].member;
		if (member) {
			const target = memberIds.get(member);
			if (!target) throw new Error(`Unknown member ${member}`);
			lines.push(`  ${id} -. "assigned" .-> ${target}`);
		}
	}
	for (const communication of definition.communications ?? []) {
		const from = memberIds.get(communication.from);
		const to = memberIds.get(communication.to);
		if (!from || !to) throw new Error("Unknown communication member");
		lines.push(`  ${from} -. "consult ${label(communication.when)}" .-> ${to}`);
	}
	return `${lines.join("\n")}\n`;
}
