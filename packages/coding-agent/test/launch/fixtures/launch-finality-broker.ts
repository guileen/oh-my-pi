/** Real broker process with an IPC-controlled filesystem preparation barrier. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const gateCwd = process.env.OMP_TEST_LAUNCH_GATE_CWD;
delete process.env.OMP_TEST_LAUNCH_GATE_CWD;
const released = Promise.withResolvers<void>();
let holding = gateCwd !== undefined;
process.on("message", message => {
	if (typeof message === "object" && message !== null && "type" in message && message.type === "release-launch") {
		holding = false;
		released.resolve();
	}
});
if (gateCwd) {
	const promises: { stat: typeof fs.promises.stat } = fs.promises;
	const originalStat = promises.stat;
	promises.stat = (async (...args: Parameters<typeof fs.promises.stat>) => {
		if (holding && String(args[0]) === gateCwd) {
			process.send?.({ type: "launch-held" });
			await released.promise;
		}
		return originalStat(...args);
	}) as typeof fs.promises.stat;
	// The broker imports the builtin's named bindings rather than its default object.
	syncBuiltinESMExports();
}
// Test loading boundary: install the controlled builtin stat before the broker binds it.
const { startDaemonBrokerFromEnvironment } = await import("../../../src/launch/broker");

await startDaemonBrokerFromEnvironment({
	onListening: () => {
		process.send?.({ type: "listening" });
	},
});
process.exit(0);
