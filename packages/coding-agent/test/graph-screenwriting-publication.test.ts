import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson } from "@oh-my-pi/pi-wire/canonical-json";
import { GraphArtifactRegistry } from "../src/graph/artifacts";
import type { GraphRef } from "@oh-my-pi/pi-wire/graph";
import { GraphHumanDecisions, GraphHumanError } from "../src/graph/human";
import {
	screenwritingApprovalQuestionRef,
	type ScreenwritingApprovalProposal,
} from "../src/graph/screenwriting-approval";
import { GraphScreenwritingPublications } from "../src/graph/screenwriting-publication";

const encode = (value: string) => new TextEncoder().encode(value);
const digest = (value: Uint8Array) => `sha256:${Bun.SHA256.hash(value, "hex")}`;

async function fixture() {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "graph-screenwriting-publication-"));
	const db = new Database(":memory:");
	const artifacts = new GraphArtifactRegistry({
		root,
		database: db,
		maxBytes: 16 * 1024 * 1024,
		authorize: async (principal, _action, scope) => principal === "alice" && canonicalJson(scope) === '["run"]',
	});
	const publishInput = async (content: string, media_type: string) => {
		const expected = {
			media_type,
			producer_attempt_id: null,
			source_ref: { id: "import", digest: "trusted" },
			access_scope: ["run"],
		};
		const artifact = await artifacts.store.publish("alice", encode(content), expected);
		await artifacts.register([{ artifact, expected }]);
		return { id: artifact.id, digest: artifact.digest };
	};
	const proposal: ScreenwritingApprovalProposal = {
		decision_id: "decision",
		run_id: "run",
		invocation_id: "approval",
		input_digest: "input",
		source_revision: "source",
		subject: await publishInput("keep scene tail", "text/plain"),
		change_scope: await publishInput(
			JSON.stringify({ version: 1, ranges: [{ start: 5, end: 10, max_replacement_bytes: 7 }] }),
			"application/json",
		),
		principal: "alice",
		author_ref: { id: "alice", digest: "author-v1" },
	};
	db.exec(
		"CREATE TABLE current_revision (id INTEGER PRIMARY KEY, revision TEXT NOT NULL, proposal TEXT NOT NULL, owner INTEGER NOT NULL, readable INTEGER NOT NULL)",
	);
	db.query("INSERT INTO current_revision VALUES (1,'7',?,1,1)").run(canonicalJson(proposal));
	const human = new GraphHumanDecisions({
		database: db,
		authorize: (_action, principal) => {
			const row = db.query("SELECT readable FROM current_revision").get() as { readable: number };
			return principal === "alice" && row.readable === 1;
		},
		fence: (_action, question) =>
			question.run_id === proposal.run_id && question.input_digest === proposal.input_digest,
	});
	human.create("alice", {
		id: proposal.decision_id,
		run_id: proposal.run_id,
		invocation_id: proposal.invocation_id,
		input_digest: proposal.input_digest,
		source_revision: proposal.source_revision,
		question_ref: screenwritingApprovalQuestionRef(proposal),
		outcomes: ["approve"],
		verdicts: ["APPROVE"],
		decisions: null,
	});
	const evidence = human.answer({
		request_key: "answer",
		principal: "alice",
		run_id: proposal.run_id,
		invocation_id: proposal.invocation_id,
		decision_id: proposal.decision_id,
		input_digest: proposal.input_digest,
		if_revision: "6",
		outcome: "approve",
		verdict: "APPROVE",
		content_ref: { id: "answer", digest: "text" },
		evidence_refs: [],
		reason: "approved",
		author_ref: proposal.author_ref,
	}).evidence_ref!;
	const service = () =>
		new GraphScreenwritingPublications({
			database: db,
			artifacts,
			human: { getHumanEvidence: human.getEvidence.bind(human) },
			assertOwner: () => {
				const row = db.query("SELECT owner FROM current_revision").get() as { owner: number };
				if (!db.inTransaction || row.owner !== 1) throw new GraphHumanError("permission_denied", "Owner lost");
			},
			checkCurrent: (candidate, revision) => {
				const row = db.query("SELECT revision,proposal FROM current_revision").get() as {
					revision: string;
					proposal: string;
				};
				if (row.revision !== revision || row.proposal !== canonicalJson(candidate))
					throw new GraphHumanError("input_stale", "Current applicability changed");
			},
		});
	const publications = service();
	const issueRequest = {
		request_key: "issue",
		proposal,
		evidence_ref: evidence,
		run_revision: "7",
		media_type: "text/plain",
		access_scope: ["run"],
	};
	const issue = () => db.transaction(() => publications.issue(issueRequest)).immediate();
	const request = (authority_ref: GraphRef, text = "act", request_key = "apply") => ({
		request_key,
		authority_ref,
		patches: [{ range: 0, replacement: encode(text) }],
	});
	const cleanup = async () => {
		artifacts.close();
		db.close();
		await fsp.rm(root, { recursive: true, force: true });
	};
	return { db, artifacts, proposal, evidence, publications, service, issueRequest, issue, request, cleanup };
}

describe("trusted bounded screenwriting publication", () => {
	it("requires issued authority, publishes exact bounded bytes, and reconciles replay after restart", async () => {
		const f = await fixture();
		try {
			await expect(f.publications.prepare("alice", f.request(f.evidence))).rejects.toThrow("not found");
			expect(() => f.publications.issue(f.issueRequest)).toThrow("owner transaction");
			const authority = f.issue();
			expect(f.issue()).toEqual(authority);
			const prepared = await f.publications.prepare("alice", f.request(authority));
			const result = f.publications.commit(prepared);
			expect(result.digest).toBe(digest(encode("keep act tail")));
			expect(new TextDecoder().decode(await f.artifacts.store.read("alice", result))).toBe("keep act tail");
			expect(f.artifacts.lookup(result)).toMatchObject({
				source_ref: f.proposal.subject,
				producer_attempt_id: null,
				access_scope: ["run"],
			});
			expect(f.publications.commit(prepared)).toEqual(result);
			f.db.query("UPDATE current_revision SET revision='8'").run();
			f.db.transaction(() => f.publications.revoke(authority)).immediate();
			const restarted = f.service();
			expect(restarted.commit(await restarted.prepare("alice", f.request(authority)))).toEqual(result);
			await expect(restarted.prepare("alice", f.request(authority, "other"))).rejects.toThrow("key already used");
			await expect(restarted.prepare("alice", f.request(authority, "act", "new-key"))).rejects.toThrow();
			const replay = await restarted.prepare("alice", f.request(authority));
			f.db.query("UPDATE current_revision SET readable=0").run();
			expect(() => restarted.commit(replay)).toThrow("not authorized");
			await expect(restarted.prepare("alice", f.request(authority))).rejects.toThrow("not authorized");
		} finally {
			await f.cleanup();
		}
	});

	it("permanently revokes historical approval and cannot reissue it under another key", async () => {
		const f = await fixture();
		try {
			const authority = f.issue();
			const prepared = await f.publications.prepare("alice", f.request(authority));
			f.db.transaction(() => f.publications.revoke(authority)).immediate();
			expect(() => f.publications.commit(prepared)).toThrow("revoked");
			expect(() => f.issue()).toThrow("revoked");
			expect(() =>
				f.db.transaction(() => f.publications.issue({ ...f.issueRequest, request_key: "fresh" })).immediate(),
			).toThrow("already bound");
			const restarted = f.service();
			await expect(restarted.prepare("alice", f.request(authority))).rejects.toThrow("revoked");
			expect(f.db.query("SELECT COUNT(*) AS n FROM graph_screenwriting_publications").get()).toEqual({ n: 0 });
		} finally {
			await f.cleanup();
		}
	});

	it("checks current version, exact proposal, authenticated author and owner at commit", async () => {
		for (const mutation of [
			"UPDATE current_revision SET revision='8'",
			"UPDATE current_revision SET proposal='{}'",
			"UPDATE current_revision SET readable=0",
			"UPDATE current_revision SET owner=0",
			"UPDATE graph_artifacts SET availability='expired'",
		]) {
			const f = await fixture();
			try {
				const authority = f.issue();
				await expect(f.publications.prepare("mallory", f.request(authority))).rejects.toThrow("approved author");
				const prepared = await f.publications.prepare("alice", f.request(authority));
				f.db.exec(mutation);
				expect(() => f.publications.commit(prepared)).toThrow();
				expect(f.db.query("SELECT COUNT(*) AS n FROM graph_screenwriting_publications").get()).toEqual({ n: 0 });
				expect(f.db.query("SELECT COUNT(*) AS n FROM graph_artifacts").get()).toEqual({ n: 2 });
			} finally {
				await f.cleanup();
			}
		}
	});

	it("rejects wrong author/input proposals and out-of-scope patches", async () => {
		const f = await fixture();
		try {
			for (const change of [
				{ principal: "mallory" },
				{ input_digest: "changed" },
				{ author_ref: { id: "alice", digest: "changed" } },
			])
				expect(() =>
					f.db
						.transaction(() =>
							f.publications.issue({ ...f.issueRequest, proposal: { ...f.proposal, ...change } }),
						)
						.immediate(),
				).toThrow();
			const authority = f.issue();
			await expect(f.publications.prepare("alice", f.request(authority, "too many bytes"))).rejects.toThrow(
				"exceeds scope",
			);
			await expect(
				f.publications.prepare("alice", {
					...f.request(authority),
					patches: [{ range: 1, replacement: encode("x") }],
				}),
			).rejects.toThrow("Invalid revision patch");
			expect(() =>
				f.db.transaction(() => f.publications.issue({ ...f.issueRequest, media_type: "other" })).immediate(),
			).toThrow("key already used");
		} finally {
			await f.cleanup();
		}
	});

	it("atomically rolls back registration with application and permits retry after lost transaction", async () => {
		const f = await fixture();
		try {
			const authority = f.issue();
			const request = f.request(authority);
			const prepared = await f.publications.prepare("alice", request);
			request.patches[0].replacement.fill(0);
			let result: GraphRef | undefined;
			expect(() =>
				f.db
					.transaction(() => {
						result = f.publications.commit(prepared);
						throw new Error("Run transition failed");
					})
					.immediate(),
			).toThrow("Run transition failed");
			expect(f.artifacts.lookup(result!)).toBeNull();
			const published = f.publications.commit(prepared);
			expect(published).toEqual(result!);
			expect(new TextDecoder().decode(await f.artifacts.store.read("alice", published))).toBe("keep act tail");
			await expect(f.publications.prepare("alice", f.request(authority, "act", "another"))).rejects.toThrow(
				"already been applied",
			);
			f.db.query("UPDATE current_revision SET owner=0").run();
			expect(() => f.publications.commit(prepared)).toThrow("Owner lost");
		} finally {
			await f.cleanup();
		}
	});

	it("refuses registry connections outside the application transaction", async () => {
		const f = await fixture();
		const other = new Database(":memory:");
		try {
			expect(() => f.artifacts.assertDatabase(other)).toThrow("same host database");
		} finally {
			other.close();
			await f.cleanup();
		}
	});
});
