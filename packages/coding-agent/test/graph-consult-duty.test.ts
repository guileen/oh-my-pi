import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { GraphDefinition } from "../src/graph/contracts";
import { validateGraphForStart } from "../src/graph/definition";
import { localRunSupport } from "../src/graph/local-run";

const limits = { maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 3000 };

function load(name: string): GraphDefinition {
	const content = readFileSync(new URL(`../examples/graph/${name}/GRAPH.md`, import.meta.url), "utf8");
	return validateGraphForStart(content, limits).source.frontmatter.frontmatter as unknown as GraphDefinition;
}

function sample(consultPermissions: string, consultNode: string): GraphDefinition {
	const content = `---
format: omp.graph/v1
name: consult-sample
members:
  writer:
    role: '#writer'
    model: binding
    base: omp-default
    duty: general
    permissions: {read: [], write: [], execute: []}
  asker:
    role: '#asker'
    model: binding
    base: omp-default
    duty: consult
    permissions: ${consultPermissions}
nodes:
  draft:
    kind: bot
    member: writer
    task: '#task'
    outputs: {draft: {media_type: text/markdown, required: true}}
  ask:
    kind: bot
    member: asker
    task: '#task'
    outputs: {answer: {media_type: text/markdown, required: true}}
    ${consultNode}
edges:
  - {id: next, from: draft, to: ask, bind: {draft: draft}}
---
## writer
Write.
## asker
Answer one question.
## task
Do the work.
`;
	return validateGraphForStart(content, limits).source.frontmatter.frontmatter as unknown as GraphDefinition;
}

describe("consult duty", () => {
	it("admits one bounded question with no tool grants", () => {
		const support = localRunSupport(sample("{read: [], write: [], execute: []}", "required_inputs: [draft]"));
		expect(support).toEqual({ supported: true, reason: null });
	});

	it("refuses a consultant that holds filesystem grants", () => {
		const support = localRunSupport(sample("{read: ['.'], write: [], execute: []}", "required_inputs: [draft]"));
		expect(support.supported).toBe(false);
		expect(support.reason).toMatch(/no read, write or execute grants/);
	});

	it("refuses a consultant that answers more than one question", () => {
		const support = localRunSupport(
			sample(
				"{read: [], write: [], execute: []}",
				"inputs: {extra: {text: x}}\n    required_inputs: [draft, extra]",
			),
		);
		expect(support.supported).toBe(false);
		expect(support.reason).toMatch(/answers exactly one required question/);
	});

	it("keeps the shipped draft template inside the consult contract", () => {
		const graph = load("requirement-spec-draft");
		expect(localRunSupport(graph)).toEqual({ supported: true, reason: null });
		const consult = graph.members.consultant;
		expect(consult?.duty).toBe("consult");
		expect(consult?.permissions).toEqual({ read: [], write: [], execute: [] });
		expect(graph.nodes.review?.member).toBe("consultant");
	});
});
