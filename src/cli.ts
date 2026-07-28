import { cli, type CliOptions } from "cleye";
import packageJson from "../package.json" with { type: "json" };

const commands = {
  init: {
    description: "Initialize Janitor in the current project",
    loader: () => import("#/commands/init"),
  },
  review: {
    description: "Run configurable code and security pull-request reviews",
    loader: () => import("#/commands/review"),
  },
} satisfies NonNullable<CliOptions["commands"]>;

export const rootCliOptions = {
  name: "janitor",
  version: packageJson.version,
  help: {
    description: packageJson.description,
  },
  commands,
  strictCommands: true,
  strictFlags: true,
} satisfies CliOptions;

export interface RunCliOptions {
  argv?: string[];
  throwOnExit?: boolean;
}

export function runCli(options: RunCliOptions = {}) {
  return cli(
    {
      ...rootCliOptions,
      throwOnExit: options.throwOnExit,
    },
    (parsed) => {
      if (parsed.command === undefined) {
        parsed.showHelp();
      }
    },
    options.argv,
  );
}
