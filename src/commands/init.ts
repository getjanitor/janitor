import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cancel, confirm, isCancel, select, text } from "@clack/prompts";
import { cli, type CliOptions } from "cleye";
import { Liquid } from "liquidjs";

const DEFAULT_JANITOR_VERSION = "latest";
const DEFAULT_GITHUB_IDENTITY: GitHubIdentity = "github-actions";
const GITHUB_IDENTITIES = ["github-actions", "github-app"] as const;
const DEFAULT_TRACKED_PATHS = ["**"];
const VERSION_OR_TAG_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

const templateUrls = {
  config: new URL("./templates/janitor.toml.liquid", import.meta.url),
  workflow: new URL("./templates/janitor.yml.liquid", import.meta.url),
};

export type GitHubIdentity = (typeof GITHUB_IDENTITIES)[number];

export interface InitOptions {
  force: boolean;
  githubIdentity: GitHubIdentity | undefined;
  janitorVersion: string | undefined;
}

export interface InitTemplateContext {
  github_app: boolean;
  janitor_package: string;
  janitor_version: string;
  tracked_paths: string[];
}

export interface RenderedInitFiles {
  config: string;
  workflow: string;
}

export type InitTargetStatus = "created" | "overwritten" | "skipped" | "unchanged";

export interface InitTargetResult {
  path: string;
  status: InitTargetStatus;
}

export interface InitResult {
  cancelled: boolean;
  targets: InitTargetResult[];
}

export interface InitPromptBoundary {
  confirmOverwrite(path: string): Promise<boolean | undefined>;
  getGitHubIdentity(): Promise<GitHubIdentity | undefined>;
  getJanitorVersion(): Promise<string | undefined>;
  reportCancellation(): void;
}

export interface InitFileSystem {
  makeDirectory(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
}

export interface InitDependencies {
  cwd?: string;
  fileSystem?: InitFileSystem;
  prompts?: InitPromptBoundary;
  report?: (result: InitTargetResult) => void;
  templateLoader?: (url: URL) => Promise<string>;
}

function validateVersionOrTag(value: string | undefined): string | undefined {
  if (value === undefined || !VERSION_OR_TAG_PATTERN.test(value)) {
    return "Use an npm version or tag containing only letters, numbers, dots, underscores, or hyphens.";
  }
}

function JanitorVersion(value: string): string {
  const version = value.trim();
  const validationError = validateVersionOrTag(version);
  if (validationError) {
    throw new Error(validationError);
  }
  return version;
}

function isGitHubIdentity(value: string): value is GitHubIdentity {
  return (GITHUB_IDENTITIES as readonly string[]).includes(value);
}

function GitHubIdentityFlag(value: string): GitHubIdentity {
  const identity = value.trim();
  if (!isGitHubIdentity(identity)) {
    throw new Error(`Use one of: ${GITHUB_IDENTITIES.join(", ")}.`);
  }
  return identity;
}

export const initCliOptions = {
  help: {
    description: "Initialize Janitor in the current project",
  },
  flags: {
    janitorVersion: {
      type: JanitorVersion,
      description: "Janitor npm version or tag for the workflow (default: latest)",
      placeholder: "<version-or-tag>",
    },
    identity: {
      type: GitHubIdentityFlag,
      description:
        "GitHub identity that posts reviews: github-actions or github-app (default: github-actions)",
      placeholder: "<identity>",
    },
    force: {
      type: Boolean,
      description: "Overwrite existing generated files without prompting",
    },
  },
  strictFlags: true,
} satisfies CliOptions;

const defaultPrompts: InitPromptBoundary = {
  async getJanitorVersion() {
    const value = await text({
      message: "Which Janitor version or npm tag should the workflow use?",
      initialValue: DEFAULT_JANITOR_VERSION,
      validate: validateVersionOrTag,
    });
    return isCancel(value) ? undefined : value.trim();
  },
  async getGitHubIdentity() {
    const value = await select<GitHubIdentity>({
      message: "Which GitHub identity should post reviews?",
      initialValue: DEFAULT_GITHUB_IDENTITY,
      options: [
        { value: "github-actions", label: "GitHub Actions bot", hint: "uses GITHUB_TOKEN" },
        {
          value: "github-app",
          label: "GitHub App",
          hint: "uses an installation token for your own app",
        },
      ],
    });
    return isCancel(value) ? undefined : value;
  },
  async confirmOverwrite(path) {
    const value = await confirm({
      message: `${path} already exists and differs. Overwrite it?`,
      initialValue: false,
    });
    return isCancel(value) ? undefined : value;
  },
  reportCancellation() {
    cancel("Initialization cancelled. No files were written.");
  },
};

const defaultFileSystem: InitFileSystem = {
  async makeDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  async readText(path) {
    return readFile(path, "utf8");
  },
  async writeText(path, content) {
    await writeFile(path, content, "utf8");
  },
};

function createLiquidEngine(): Liquid {
  const engine = new Liquid({
    outputDelimiterLeft: "{=",
    outputDelimiterRight: "=}",
    ownPropertyOnly: true,
    strictFilters: true,
    strictVariables: true,
  });
  engine.registerFilter("json_string", (value: unknown) => {
    if (typeof value !== "string") {
      throw new TypeError("json_string expects a string");
    }
    return JSON.stringify(value);
  });
  return engine;
}

async function defaultTemplateLoader(url: URL): Promise<string> {
  return readFile(url, "utf8");
}

export async function renderInitFiles(
  context: InitTemplateContext,
  templateLoader: (url: URL) => Promise<string> = defaultTemplateLoader,
): Promise<RenderedInitFiles> {
  const [configTemplate, workflowTemplate] = await Promise.all([
    templateLoader(templateUrls.config),
    templateLoader(templateUrls.workflow),
  ]);
  const engine = createLiquidEngine();
  const [config, workflow] = await Promise.all([
    engine.parseAndRender(configTemplate, context),
    engine.parseAndRender(workflowTemplate, context),
  ]);
  return { config, workflow };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readExistingFile(
  path: string,
  fileSystem: InitFileSystem,
): Promise<string | undefined> {
  try {
    return await fileSystem.readText(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

interface PendingTarget {
  absolutePath: string;
  content: string;
  path: string;
  status: InitTargetStatus;
  write: boolean;
}

export async function init(
  options: InitOptions = {
    force: false,
    githubIdentity: undefined,
    janitorVersion: undefined,
  },
  dependencies: InitDependencies = {},
): Promise<InitResult> {
  const prompts = dependencies.prompts ?? defaultPrompts;
  const selectedJanitorVersion = options.janitorVersion ?? (await prompts.getJanitorVersion());
  if (selectedJanitorVersion === undefined) {
    prompts.reportCancellation();
    return { cancelled: true, targets: [] };
  }
  const janitorVersion = JanitorVersion(selectedJanitorVersion);
  const githubIdentity = options.githubIdentity ?? (await prompts.getGitHubIdentity());
  if (githubIdentity === undefined) {
    prompts.reportCancellation();
    return { cancelled: true, targets: [] };
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const rendered = await renderInitFiles(
    {
      github_app: githubIdentity === "github-app",
      janitor_package: `@matfire/janitor@${janitorVersion}`,
      janitor_version: janitorVersion,
      tracked_paths: DEFAULT_TRACKED_PATHS,
    },
    dependencies.templateLoader,
  );
  const targetDefinitions = [
    { path: "janitor.toml", content: rendered.config },
    { path: ".github/workflows/janitor.yml", content: rendered.workflow },
  ];
  const inspectedTargets = await Promise.all(
    targetDefinitions.map(async (target) => {
      const absolutePath = join(cwd, target.path);
      const existing = await readExistingFile(absolutePath, fileSystem);
      return { ...target, absolutePath, existing };
    }),
  );
  const targets: PendingTarget[] = [];

  for (const target of inspectedTargets) {
    const { existing, ...pendingTarget } = target;
    if (existing === target.content) {
      targets.push({ ...pendingTarget, status: "unchanged", write: false });
    } else if (existing === undefined) {
      targets.push({ ...pendingTarget, status: "created", write: true });
    } else if (options.force) {
      targets.push({ ...pendingTarget, status: "overwritten", write: true });
    } else {
      const overwrite = await prompts.confirmOverwrite(target.path);
      if (overwrite === undefined) {
        prompts.reportCancellation();
        return { cancelled: true, targets: [] };
      }
      targets.push({
        ...pendingTarget,
        status: overwrite ? "overwritten" : "skipped",
        write: overwrite,
      });
    }
  }

  for (const target of targets) {
    if (target.write) {
      await fileSystem.makeDirectory(dirname(target.absolutePath));
      await fileSystem.writeText(target.absolutePath, target.content);
    }
  }

  const results = targets.map(({ path, status }) => ({ path, status }));
  const report =
    dependencies.report ?? ((result) => console.log(`${result.status}: ${result.path}`));
  for (const result of results) {
    report(result);
  }
  return { cancelled: false, targets: results };
}

export type InitAction = (options: InitOptions) => unknown | Promise<unknown>;

export function runInitCommand(action: InitAction = init, argv?: string[]) {
  return cli(
    initCliOptions,
    ({ flags }) =>
      action({
        force: flags.force ?? false,
        githubIdentity: flags.identity,
        janitorVersion: flags.janitorVersion,
      }),
    argv,
  );
}

export default function initCommand() {
  return runInitCommand();
}
