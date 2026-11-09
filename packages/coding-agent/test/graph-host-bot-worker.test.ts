import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BotRuntime } from "../src/bots/agent-runtime";
import { BotStore } from "../src/bots/store";
import { BotWorker } from "../src/bots/worker";
import type { GraphArtifact } from "../src/graph/artifacts";
import { createGraphBotTools, prepareGraphBot } from "../src/graph/executors/bot";
import { GraphHost } from "../src/graph/host";
import { runGraphCommand } from "../src/graph/cli";
import { GraphRunStore } from "../src/graph/store";
import * as daemonClient from "../src/launch/client";
import type { DaemonBrokerClient } from "../src/launch/client";

for (const scenario of [
	"success",
	"communication-context",
	"stop-fails",
	"admission-response-lost",
	"reply-fails",
	"cancel",
	"waiting-cancel",
	"artifact-admission-mutation",
	"artifact-collection-mutation",
	"wire-profile-mismatch",
	"wire-bot-mismatch",
	"wire-config-mismatch",
	"resolver-intent-mutation",
	"recovery-resolver-mutation",
	"reply-authorization-mutation",
	"reply-caller-mutation",
	"reply-intent-mutation",
	"consult-node",
] as const)
	it(`runs a Graph Bot through the durable targeted Bot worker (${scenario})`, async () => {
		let stopFails = scenario === "stop-fails" || scenario === "recovery-resolver-mutation";
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-host-bot-worker-"));
		const graphs = new GraphRunStore(
			{ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 },
			path.join(root, "graphs"),
		);
		const bots = new BotStore(path.join(root, "bots"));
		const registry = graphs.configureArtifacts({
			maxBytes: 4096,
			authorize: async (principal, _action, scope) => scope.includes(principal),
		});
		let artifact: GraphArtifact | undefined;
		let preparations = 0;
		const hasArtifact = scenario === "artifact-admission-mutation" || scenario === "artifact-collection-mutation";
		let host: GraphHost | undefined;
		let blocker: BotWorker | undefined;
		let disposed = 0;
		let runtimes = 0;
		let replyReserved = false;
		let resolutions = 0;
		let replyUnknown = false;
		const directReply = scenario.startsWith("reply-") && scenario !== "reply-fails";
		const replyAdmission = Promise.withResolvers<void>();
		const allowReply = Promise.withResolvers<void>();
		const consultation = {
			recoverDeliveries: () => [],
			activeRunIds: () => [],
			expire: () => {},
			pendingDeliveries: () =>
				scenario === "reply-fails" && !replyReserved
					? [
							{
								kind: "reply",
								conversation_id: "conversation",
								message_id: "reply",
								in_reply_to: "question",
								recipient_member: "reviewer",
							},
						]
					: [],
			get: () => ({ state: "active" }),
			reserveDelivery: () => {
				replyReserved = true;
				return { ok: true, value: { claimed: true } };
			},
			settleDelivery: (_identity: unknown, _message: unknown, state: string) => {
				if (state === "unknown") replyUnknown = true;
				return true;
			},
			list: () => [],
		};
		let brokerFails = true;
		const broker = vi.spyOn(daemonClient, "daemonClientForProject").mockImplementation(async () => {
			if (brokerFails) throw new Error("temporary broker failure");
			return {
				request: async (request: { op: string; through_epoch?: string }) =>
					request.op === "fence_owner"
						? { op: "fence_owner", fenced_through_epoch: request.through_epoch }
						: { op: "list", daemons: [] },
			} as unknown as DaemonBrokerClient;
		});
		try {
			const bot = bots.createBot({ bot_name: "reviewer", cwd: root });
			const content = `---
format: omp.graph/v1
name: bot-worker
members:
  reviewer:
    role: '#role'
    model: binding
    base: isolated
    duty: ${scenario === "consult-node" ? "consult" : "review"}
    permissions: {read: [], write: [], execute: []}
${scenario === "communication-context" ? "  adviser: {role: '#role', model: binding, base: isolated, duty: review, permissions: {read: [], write: [], execute: []}}" : ""}
nodes:
  review:
    kind: bot
    member: reviewer
    task: '#task'
    outcomes: [done, changed]
    outputs: {plan: {media_type: text/plain, required: false}}
    terminal: {done: succeed, changed: succeed}
${scenario === "communication-context" ? "communications:\n  - {from: reviewer, to: adviser, when: '#consulting'}\n  - {from: adviser, to: reviewer, when: '#incoming'}" : ""}
---
## role
Review.
## task
Inspect.
## consulting
Ask for evidence review before finalizing <the plan>.
## incoming
Private instructions for the adviser.
`;
			const imported = graphs.definitions.mutate({
				version: 1,
				request_key: "import",
				operation: "import",
				target_id: null,
				if_revision: null,
				payload: { content },
			});
			const definition = graphs.definitions.get(imported.target_id!)!;
			const ref = { id: "grant", digest: "sha256:grant" };
			const started = graphs.start(
				{
					version: 1,
					request_key: "start",
					operation: "start",
					target_id: definition.graph_id,
					if_revision: definition.revision,
					payload: { inputs: {}, authorization_ref: ref },
				},
				{
					graph_id: definition.graph_id,
					definition_revision: definition.revision,
					definition_digest: definition.digest,
					authorization_ref: ref,
					inputs: {},
					executors: {},
					members: {
						reviewer: {
							provider: "provider",
							model: "model",
							configuration_revision: "1",
							base: "isolated",
							base_snapshot_ref: ref,
							role_ref: ref,
							skill_refs: [],
							rule_refs: [],
						},
					},
					...(scenario === "communication-context"
						? {
								members: Object.fromEntries(
									["reviewer", "adviser"].map(id => [
										id,
										{
											provider: "provider",
											model: "model",
											configuration_revision: "1",
											base: "isolated" as const,
											base_snapshot_ref: ref,
											role_ref: ref,
											skill_refs: [],
											rule_refs: [],
										},
									]),
								),
							}
						: {}),
					...(scenario === "success" || scenario.startsWith("wire-")
						? {
								observation: {
									source_id: "graph-source",
									members: {
										reviewer: {
											bot: {
												source_id: "reviewer-source",
												profile_id:
													scenario === "wire-profile-mismatch" ? "other-profile" : bots.profile_id,
												bot_id: scenario === "wire-bot-mismatch" ? "other-bot" : bot.bot_id,
											},
											config_revision:
												scenario === "wire-config-mismatch" ? "other-config" : bot.config_revision,
											model_binding_ref: ref,
										},
									},
								},
							}
						: {}),
				},
			);
			expect(started.state).toBe("accepted");
			if (scenario === "communication-context") {
				expect(
					graphs.definitions.mutate({
						version: 1,
						request_key: "edit-context",
						operation: "edit",
						target_id: definition.graph_id,
						if_revision: definition.revision,
						payload: { content: content.replace("Ask for evidence review", "Send secrets instead") },
					}).error,
				).toBeNull();
			}
			let preparedPrompt = "";
			const other = bots.admit(bot.bot_id, { command: "submit", input: "unrelated" });
			blocker = new BotWorker(bots, bot.bot_id);
			expect(blocker.claim()).toBe(true);
			const release = Promise.withResolvers<void>();
			let entered = false;
			const model = { provider: "provider", id: "model" };
			const modelRegistry = { getAvailableForProviders: () => [model], hasConfiguredAuth: () => true };
			if (scenario === "reply-fails") vi.spyOn(graphs, "resumeConsultation").mockReturnValue(true);
			host = new GraphHost({
				store: graphs,
				consultation: scenario === "reply-fails" ? (consultation as never) : undefined,
				program: {
					accept: async () => {
						throw new Error("unexpected program");
					},
					query: () => null,
					cancel: () => "unknown",
				},
				resolveProgram: async () => {
					throw new Error("unexpected program");
				},
				verifyProgramResult: async () => {
					throw new Error("unexpected program");
				},
				bot: {
					store: bots,
					authorize: () => true,
					admitReply: async (intent, reply) => {
						replyAdmission.resolve();
						if (scenario === "reply-caller-mutation") await allowReply.promise;
						if (scenario === "reply-authorization-mutation") reply.input = "unapproved replacement";
						if (scenario === "reply-intent-mutation") intent.attempt_id = "unapproved attempt";
						return "accepted";
					},
					prepareArtifacts: async (_intent, candidate) => {
						if (!artifact) throw new Error("Output artifact missing");
						const prepared = await registry.prepareRegistration([
							{
								artifact,
								expected: {
									media_type: "text/plain",
									producer_attempt_id: artifact.producer_attempt_id,
									source_ref: null,
									access_scope: ["alice"],
								},
							},
						]);
						preparations++;
						if (
							(scenario === "artifact-admission-mutation" && preparations === 1) ||
							(scenario === "artifact-collection-mutation" && preparations === 2)
						)
							candidate.outcome = "changed";
						return prepared;
					},
					resolve: async intent => {
						if (scenario === "resolver-intent-mutation") intent.attempt_id = "substituted-attempt";
						resolutions++;
						if (scenario === "recovery-resolver-mutation" && resolutions > 1)
							intent.attempt_id = "substituted-recovery-attempt";
						return {
							job: {
								job_id: "template",
								bot_id: bot.bot_id,
								config_revision: bot.config_revision,
								graph_context: {
									graph_id: definition.graph_id,
									graph_run_id: intent.run_id,
									invocation_id: intent.invocation_id,
									node_id: "review",
									attempt: 1,
									upstream: [],
								},
							} as never,
							member_id: "reviewer",
							input: "Review",
							callbacks: { onEvent() {} },
							assignment: {
								member: graphs.getFrozenDefinition(intent.run_id)!.members.reviewer,
								role: "Review",
								task: "Inspect",
								bindings: [{ name: "binding", provider: "provider", model: "model", revision: "1" }],
								modelRegistry: modelRegistry as never,
								baseAvailable: true,
								assertToolCall: () => {},
							},
						};
					},
					createRuntime: async (_job, callbacks, assignment) => {
						runtimes++;
						if (scenario === "consult-node") {
							// A consult member that owns a node must complete it; only a live
							// consultation recipient trades completion for reply/finish.
							expect(assignment.tools?.consultRecipient).not.toBe(true);
							expect(createGraphBotTools(assignment.tools!).map(tool => tool.name)).toContain("graph_complete");
						}
						if (scenario === "communication-context")
							preparedPrompt = prepareGraphBot(assignment).graph.appendPrompt ?? "";
						let waiting = false;
						let streaming = false;
						let cancelled = false;
						const runtime: BotRuntime = {
							async prompt() {
								callbacks.assertDispatch?.();
								streaming = true;
								callbacks.onEvent({ type: "execution_start" });
								if (scenario === "success")
									callbacks.onEvent({
										type: "usage",
										input_tokens: 10,
										output_tokens: 2,
										cache_read_tokens: 0,
										cache_write_tokens: 0,
										cost_usd: "0.1",
									});
								entered = true;
								if (scenario === "reply-fails") {
									streaming = false;
									waiting = true;
									callbacks.onEvent({
										type: "input_required",
										input_request_id: "input",
										kind: "text",
										prompt: {
											graph_consultation: { conversation_id: "conversation", message_id: "question" },
										},
									});
								}
								if (directReply) {
									streaming = false;
									waiting = true;
									callbacks.onEvent({
										type: "input_required",
										input_request_id: "input",
										kind: "text",
										prompt: "Confirm the plan",
									});
									return;
								}
								await release.promise;
								if (cancelled) return;
								if (scenario === "success")
									callbacks.onEvent({
										type: "usage",
										input_tokens: null,
										output_tokens: 3,
										cache_read_tokens: null,
										cache_write_tokens: null,
										cost_usd: null,
									});
								if (hasArtifact)
									artifact = await registry.store.publish("alice", Buffer.from("reviewed plan"), {
										media_type: "text/plain",
										producer_attempt_id: graphs.getDispatchIntents(started.target_id!)[0].attempt_id,
										source_ref: null,
										access_scope: ["alice"],
									});
								const result = await assignment.tools!.completion.submit({
									request_key: "result",
									outcome: "done",
									outputs: artifact ? { plan: { id: artifact.id, digest: artifact.digest } } : {},
								});
								if (result.state !== "accepted") throw new Error("completion rejected");
								streaming = false;
								callbacks.onEvent({ type: "execution_end", outcome: "returned" });
							},
							async reply() {
								if (!directReply) throw new Error("unexpected reply");
								waiting = false;
								streaming = true;
								callbacks.onEvent({ type: "execution_start" });
								const result = await assignment.tools!.completion.submit({
									request_key: "result",
									outcome: "done",
									outputs: {},
								});
								if (result.state !== "accepted") throw new Error("completion rejected");
								streaming = false;
								callbacks.onEvent({ type: "execution_end", outcome: "returned" });
							},
							async steer() {},
							async abort() {},
							async stop() {
								if (stopFails) throw new Error("stop failed");
								if (scenario === "cancel") {
									cancelled = true;
									streaming = false;
									release.resolve();
								}
							},
							async compact() {},
							async setModel() {},
							messages: () => [],
							async dispose() {
								disposed++;
							},
							state: () => ({
								is_streaming: streaming,
								waiting_input_count: waiting ? 1 : 0,
								waiting_input_requests: waiting
									? [
											{
												input_request_id: "input",
												kind: "text",
												prompt: directReply
													? "Confirm the plan"
													: {
															graph_consultation: {
																conversation_id: "conversation",
																message_id: "question",
															},
														},
											},
										]
									: [],
								pending_background_count: 0,
								pending_delivery_count: 0,
								context: { used_tokens: null, limit_tokens: null },
								model: "model",
								progress: null,
								session_file: null,
							}),
						};
						return { runtime, binding: assignment.bindings[0] };
					},
				},
			});
			expect(host.start()).toBe(true);
			for (let i = 0; i < 10 && !graphs.getDispatchIntents(started.target_id!).length; i++) await host.tick();
			if (scenario.startsWith("wire-")) {
				const intent = graphs.getDispatchIntents(started.target_id!)[0];
				expect(intent.state).toBe("unknown");
				expect(intent.observation).toMatchObject({
					reason: expect.stringContaining("frozen observation source"),
				});
				expect(bots.graphHostedByKey(bot.bot_id, intent.request_key)).toBeNull();
				expect(runtimes).toBe(0);
				return;
			}
			expect(graphs.getDispatchIntents(started.target_id!)[0]).toMatchObject({ state: "submitting" });
			expect(bots.jobs(bot.bot_id)).toHaveLength(1);
			if (scenario === "waiting-cancel") {
				graphs.configureLifecycle({ authorize: () => true, verifyResume: () => false });
				expect(
					graphs.mutateLifecycle("owner", {
						version: 1,
						operation: "cancel",
						request_key: "cancel-before-admission",
						target_id: started.target_id!,
						if_revision: graphs.getRun(started.target_id!)!.revision,
						payload: { reason: "Do not wait for the busy Bot" },
					}).state,
				).toBe("completed");
				await host.tick();
				expect(graphs.getRun(started.target_id!)?.state).toBe("cancelled");
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe("finished");
				expect(bots.jobs(bot.bot_id)).toHaveLength(1);
				expect(bots.request(bot.bot_id, other.request_id).outcome).toBe("pending");
				expect(runtimes).toBe(0);
				return;
			}
			await blocker.close();
			blocker = undefined;
			if (scenario === "admission-response-lost") {
				const admit = bots.admitGraph.bind(bots);
				const spy = vi.spyOn(bots, "admitGraph").mockImplementation((...args) => {
					admit(...args);
					throw new Error("admission response lost");
				});
				try {
					await host.tick();
				} finally {
					spy.mockRestore();
				}
				const job = bots.jobs(bot.bot_id).find(item => item.graph_context?.graph_run_id === started.target_id)!;
				expect(job.state).toBe("queued");
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe("unknown");
				await host.tick();
				expect(bots.getJob(bot.bot_id, job.job_id)).toMatchObject({
					state: "stopped",
					settled: true,
					ownership: { state: "none" },
				});
				expect(runtimes).toBe(0);
				expect(bots.request(bot.bot_id, other.request_id).outcome).toBe("pending");
				return;
			}
			for (let i = 0; i < 100 && !entered; i++) {
				await host.tick();
				await Promise.resolve();
			}
			expect(entered).toBe(true);
			if (scenario === "communication-context") {
				expect(preparedPrompt).toContain("adviser");
				expect(preparedPrompt).toContain("Ask for evidence review before finalizing <the plan>.");
				expect(preparedPrompt).not.toContain("Send secrets instead");
				expect(preparedPrompt).not.toContain("Private instructions for the adviser.");
			}
			const activeJob = bots.jobs(bot.bot_id).find(item => item.graph_context?.graph_run_id === started.target_id);
			expect(activeJob).toBeDefined();
			if (scenario === "success") {
				await host.tick();
				expect(graphs.getRun(started.target_id!)?.observed_bot_usage).toMatchObject({
					input_tokens: 10,
					output_tokens: 2,
					cost_usd: "0.1",
					completeness: "complete",
					observed_sources: 1,
				});
			}
			expect(() =>
				bots.admit(bot.bot_id, {
					command: "send",
					job_id: activeJob!.job_id,
					input: "unauthorized",
					key: "bypass",
				}),
			).toThrow();
			if (scenario === "cancel") {
				graphs.configureLifecycle({ authorize: () => true, verifyResume: () => false });
				expect(
					graphs.mutateLifecycle("owner", {
						version: 1,
						request_key: "cancel",
						operation: "cancel",
						target_id: started.target_id!,
						if_revision: graphs.getRun(started.target_id!)!.revision,
						payload: { reason: "Stop the active Bot" },
					}).state,
				).toBe("completed");
				expect(graphs.getRun(started.target_id!)?.state).toBe("cancelling");
				await host.tick();
				expect(bots.getJob(bot.bot_id, activeJob!.job_id)).toMatchObject({
					state: "stopped",
					settled: true,
					ownership: { state: "none" },
				});
				expect(graphs.getRun(started.target_id!)?.state).toBe("cancelled");
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe("finished");
				expect(graphs.getAttemptHistory(started.target_id!)).toMatchObject([
					{ accepted: true, completion: { state: "cancelled" } },
				]);
				expect(runtimes).toBe(1);
				expect(disposed).toBe(1);
				expect(bots.request(bot.bot_id, other.request_id).outcome).toBe("pending");
				const revision = graphs.getRun(started.target_id!)!.revision;
				await host.tick();
				expect(graphs.getRun(started.target_id!)!.revision).toBe(revision);
				expect(runtimes).toBe(1);
				return;
			}
			if (directReply) {
				const reply = { request_key: "approved-reply", input_request_id: "input", input: "approved answer" };
				let settled = false;
				let result: string | undefined;
				let failure: unknown;
				const delivery = host
					.replyBot(graphs.getDispatchIntents(started.target_id!)[0].id, reply)
					.then(value => {
						result = value;
					})
					.catch(error => {
						failure = error;
					})
					.finally(() => {
						settled = true;
					});
				await replyAdmission.promise;
				if (scenario === "reply-caller-mutation") reply.input = "changed while authorization pending";
				allowReply.resolve();
				for (let i = 0; i < 200 && !settled; i++) {
					await host.tick();
					await Promise.resolve();
				}
				expect(settled).toBe(true);
				await delivery;
				expect(failure).toBeUndefined();
				expect(result).toBe("accepted");
				expect(bots.messages(bot.bot_id, activeJob!.job_id).items).toContainEqual(
					expect.objectContaining({ role: "user", content: "approved answer" }),
				);
			}
			if (scenario === "reply-fails") {
				for (let i = 0; i < 100 && !replyReserved; i++) await host.tick();
				expect(replyReserved).toBe(true);
				const pending = vi.spyOn(bots, "pendingRequests").mockImplementation(() => {
					throw new Error("reply delivery failed");
				});
				try {
					await host.tick();
				} finally {
					pending.mockRestore();
				}
				for (let i = 0; i < 10 && !replyUnknown; i++) {
					await Promise.resolve();
					await host.tick();
				}
				expect(replyUnknown).toBe(true);
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe("unknown");
				expect(graphs.getRun(started.target_id!)?.state).toBe("held");
				await host.tick();
				expect(disposed).toBe(1);
				await host.tick();
				expect(runtimes).toBe(1);
				return;
			}
			release.resolve();
			for (
				let i = 0;
				i < 200 &&
				(stopFails
					? graphs.getDispatchIntents(started.target_id!)[0].state !== "unknown"
					: graphs.getRun(started.target_id!)?.state !== "succeeded");
				i++
			) {
				await host.tick();
				if (hasArtifact) await Bun.sleep(1);
				else await Promise.resolve();
			}
			if (stopFails) {
				expect(graphs.getDispatchIntents(started.target_id!)[0].state).toBe("unknown");
				expect(disposed).toBe(0);
				expect(bots.getJob(bot.bot_id, activeJob!.job_id).settled).toBe(false);
				stopFails = false;
				bots.updateJob(bot.bot_id, activeJob!.job_id, { pending_delivery_count: 1 });
				await host.tick();
				const eventCount = bots.events(bot.bot_id, { limit: 1000 }).items.length;
				await host.tick();
				expect(bots.events(bot.bot_id, { limit: 1000 }).items).toHaveLength(eventCount);
				brokerFails = false;
				bots.updateJob(bot.bot_id, activeJob!.job_id, { pending_delivery_count: 0 });
				const now = Date.now();
				const clock = vi.spyOn(Date, "now").mockReturnValue(now + 1100);
				try {
					await host.tick();
				} finally {
					clock.mockRestore();
				}
				expect(bots.getJob(bot.bot_id, activeJob!.job_id)).toMatchObject({
					state: "stopped",
					settled: true,
					ownership: { state: "none" },
				});
				expect(disposed).toBe(1);
				expect(graphs.getRun(started.target_id!)?.state).toBe("held");
				expect(graphs.getAttemptHistory(started.target_id!)).toMatchObject([
					{ accepted: true, completion: { state: "failed" } },
				]);
				expect(runtimes).toBe(1);
			} else {
				if (hasArtifact) expect(bots.getJob(bot.bot_id, activeJob!.job_id).error).toBeNull();
				expect(graphs.getRun(started.target_id!)?.state).toBe("succeeded");
			}
			if (hasArtifact) {
				const invocation = graphs.getScheduleState(started.target_id!)!.invocations[0];
				expect(invocation.outcome).toBe("done");
				expect(graphs.getBotCompletion(invocation.attempt_id!)?.candidate.outcome).toBe("done");
				expect(Buffer.from(await registry.store.read("alice", invocation.outputs!.plan)).toString()).toBe(
					"reviewed plan",
				);
				expect(preparations).toBe(2);
			}
			if (scenario === "success") {
				const expected = {
					input_tokens: 10,
					output_tokens: 5,
					cost_usd: "0.1",
					completeness: "partial",
					observed_sources: 1,
				};
				expect(graphs.getRun(started.target_id!)?.observed_bot_usage).toMatchObject(expected);
				await host.tick();
				expect(graphs.getRun(started.target_id!)?.observed_bot_usage).toMatchObject(expected);
				const owner = graphs.claimHost()!;
				const intent = graphs.getDispatchIntents(started.target_id!)[0];
				const revision = graphs.getRun(started.target_id!)!.revision;
				const unrelated = bots.createBot({ bot_name: "unrelated-source", cwd: root });
				expect(() => graphs.recordBotUsage("stale-owner", owner.epoch, intent.id, bots, bot.bot_id)).toThrow();
				expect(() =>
					graphs.recordBotUsage(owner.owner_id, owner.epoch, intent.id, bots, unrelated.bot_id),
				).toThrow();
				graphs.recordBotUsage(owner.owner_id, owner.epoch, intent.id, bots, bot.bot_id);
				expect(graphs.getRun(started.target_id!)!.revision).toBe(revision);
				expect(graphs.getRun(started.target_id!)?.observed_bot_usage).toMatchObject(expected);
				const reopened = new GraphRunStore(
					{ maxBytes: 65536, maxDepth: 32, maxAliases: 100, maxNodes: 1000 },
					path.join(root, "graphs"),
				);
				try {
					expect(reopened.getRun(started.target_id!)?.observed_bot_usage).toMatchObject(expected);
				} finally {
					reopened.close();
				}
				let output = "";
				expect(
					await runGraphCommand(["status", started.target_id!], {
						root: path.join(root, "graphs"),
						authorizeRunObservation: () => true,
						out: text => {
							output += text;
						},
						err() {},
					}),
				).toBe(0);
				expect(output).toContain("Observed Bot cost (USD): 0.1");
				expect(output).toContain("partial");
			}
			const job = bots.jobs(bot.bot_id).find(item => item.graph_context?.graph_run_id === started.target_id);
			expect(job).toBeDefined();
			expect(job!.settled).toBe(true);
			expect(bots.getJob(bot.bot_id, other.job_id!).state).toBe("queued");
			expect(bots.request(bot.bot_id, other.request_id).outcome).toBe("pending");
		} finally {
			stopFails = false;
			brokerFails = false;
			await blocker?.close();
			await host?.shutdown();
			broker.mockRestore();
			bots.close();
			graphs.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
