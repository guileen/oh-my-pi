/**
 * List, search, and refresh available models.
 */

import { MODEL_KINDS, type ModelKind } from "@oh-my-pi/pi-catalog/types";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { modelsHelp as commandHelp } from "../cli/command-help";
import { resolveModelsArgs, runModelsCommand } from "../cli/models-cli";

const MODEL_KIND_OPTIONS: readonly (ModelKind | "all")[] = [...MODEL_KINDS, "all"];

export default class Models extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "ls (default) | find | refresh | <provider>",
			required: false,
		}),
		pattern: Args.string({
			description: "Filter/search substring, or provider name (required for find)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		compact: Flags.boolean({
			char: "c",
			description: "One borderless line per model (default when stdout is not a TTY)",
		}),
		kind: Flags.string({
			description: "Catalog kind to list",
			options: MODEL_KIND_OPTIONS,
			default: "chat",
		}),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before listing (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		full: Flags.boolean({
			description: "Bare `omp models`: list every model instead of the provider index",
		}),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	};

	static examples = [
		`# List available chat models, grouped by provider\n  ${APP_NAME} models`,
		`# List models of every catalog kind\n  ${APP_NAME} models --kind all`,
		`# List one provider's models (any provider name works)\n  ${APP_NAME} models openai-codex`,
		`# Find models by substring\n  ${APP_NAME} models find minimax`,
		`# Force a fresh catalog fetch (replaces rm -rf ~/.omp/models.db)\n  ${APP_NAME} models refresh`,
		`# Machine-readable output\n  ${APP_NAME} models --json`,
		`# One line per model, no table borders (automatic for pipes)\n  ${APP_NAME} models openai-codex --compact`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Models);
		const { action, pattern } = resolveModelsArgs(args.action, args.pattern);
		const kind = MODEL_KIND_OPTIONS.find(option => option === flags.kind) ?? "chat";
		// A bare `omp models` is an orientation screen; `--full` or a provider name asks
		// for the catalog. Piped stdout drops the box table so agents read one row each.
		const bare = args.action === undefined;
		await runModelsCommand({
			action,
			pattern,
			flags: {
				json: flags.json,
				compact: flags.compact,
				index: bare && !flags.full && !flags.json,
				kind,
				extensions: flags.extension,
				noExtensions: flags["no-extensions"],
				config: flags.config,
			},
		});
	}
}
