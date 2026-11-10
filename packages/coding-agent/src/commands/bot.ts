import { Command } from "@oh-my-pi/pi-utils/cli";
import { botHelp, runBotCommand } from "../bots/cli";

export default class Bot extends Command {
	static description = botHelp.description;
	static args = botHelp.args;
	static flags = botHelp.flags;
	static examples = botHelp.examples;
	static strict = false;

	async run(): Promise<void> {
		const exitCode = await runBotCommand(this.argv);
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
