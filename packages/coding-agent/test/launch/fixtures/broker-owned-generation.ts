// One broker process per regression: namespace spies never mutate another test file's imports.
import { spyOn } from "bun:test";
import { startDaemonBrokerFromEnvironment } from "../../../src/launch/broker";
import * as owned from "../../../src/launch/owned-supervisor";

const signal = owned.signalOwnedSupervisor;
const input = owned.sendOwnedSupervisorInput;
const prepare = owned.prepareOwnedSupervisor;
const released = Promise.withResolvers<void>();
const calls: { generation: string; signal: number }[] = [];
let gate: "signal" | "input" | "prepare" | undefined;
let generation: string | undefined;

async function exited(ref: owned.OwnedSupervisorRef): Promise<owned.OwnedSupervisorStatus> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const status = await owned.queryOwnedSupervisor(ref, 250);
		if (status.state === "exited") return status;
		await Bun.sleep(10);
	}
	throw new Error("Original owned application did not exit");
}

process.on("message", message => {
	if (typeof message !== "object" || message === null || !("type" in message)) return;
	if (
		message.type === "arm" &&
		"gate" in message &&
		(message.gate === "signal" || message.gate === "input" || message.gate === "prepare") &&
		"generation" in message &&
		typeof message.generation === "string"
	) {
		gate = message.gate;
		generation = message.generation;
		process.send?.({ type: "armed" });
	} else if (message.type === "release") {
		released.resolve();
	} else if (message.type === "calls") {
		process.send?.({ type: "calls", calls });
	}
});

const signalSpy = spyOn(owned, "signalOwnedSupervisor").mockImplementation(async (ref, number, group, timeoutMs) => {
	calls.push({ generation: ref.generation, signal: number });
	const hold = gate === "signal" && generation === ref.generation && number === 15;
	if (hold) gate = undefined;
	const result = await signal(ref, number, group, timeoutMs);
	if (!hold) return result;
	// Return a real authenticated terminal reply, but only after the test replaces its generation.
	const status = await exited(ref);
	process.send?.({ type: "held", status });
	await released.promise;
	return { ...result, status };
});
const inputSpy = spyOn(owned, "sendOwnedSupervisorInput").mockImplementation(async (ref, data, timeoutMs) => {
	const hold = gate === "input" && generation === ref.generation;
	if (hold) gate = undefined;
	const result = await input(ref, data, timeoutMs);
	if (hold) {
		process.send?.({ type: "held", status: result });
		await released.promise;
	}
	return result;
});
const prepareSpy = spyOn(owned, "prepareOwnedSupervisor").mockImplementation(async (dir, spec, identity) => {
	const hold = gate === "prepare";
	if (hold) gate = undefined;
	const ref = await prepare(dir, spec, identity);
	if (hold) {
		process.send?.({ type: "held" });
		await released.promise;
	}
	return ref;
});

try {
	await startDaemonBrokerFromEnvironment({
		onListening: () => process.send?.({ type: "listening" }),
	});
} finally {
	released.resolve();
	prepareSpy.mockRestore();
	inputSpy.mockRestore();
	signalSpy.mockRestore();
}
process.exit(0);
