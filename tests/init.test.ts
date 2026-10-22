import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  init,
  renderInitFiles,
  type InitOptions,
  type InitPromptBoundary,
  type InitTargetResult,
} from "#/commands/init";

const temporaryDirectories: string[] = [];

const completeOptions: InitOptions = {
  force: false,
  githubIdentity: "github-actions",
  janitorVersion: "latest",
};

function createPrompts(overrides: Partial<InitPromptBoundary> = {}): InitPromptBoundary & {
  confirmOverwrite: ReturnType<typeof vi.fn<InitPromptBoundary["confirmOverwrite"]>>;
  getGitHubIdentity: ReturnType<typeof vi.fn<InitPromptBoundary["getGitHubIdentity"]>>;
  getJanitorVersion: ReturnType<typeof vi.fn<InitPromptBoundary["getJanitorVersion"]>>;
  reportCancellation: ReturnType<typeof vi.fn<InitPromptBoundary["reportCancellation"]>>;
} {
  return {
    confirmOverwrite: vi.fn(overrides.confirmOverwrite ?? (async () => true)),
    getGitHubIdentity: vi.fn(overrides.getGitHubIdentity ?? (async () => "github-actions")),
    getJanitorVersion: vi.fn(overrides.getJanitorVersion ?? (async () => "latest")),
    reportCancellation: vi.fn(overrides.reportCancellation ?? (() => undefined)),
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "janitor-init-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function readTarget(directory: string, path: string): Promise<string> {
  return readFile(join(directory, path), "utf8");
}

async function writeTarget(directory: string, path: string, content: string): Promise<void> {
  const target = join(directory, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function expectTargetNotToExist(directory: string, path: string): Promise<void> {
  await expect(access(join(directory, path))).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  vi.restoreAllMocks();
});

describe("init template rendering", () => {
  it("renders TOML-safe strings and preserves GitHub expressions", async () => {
    const rendered = await renderInitFiles({
      github_app: false,
      janitor_package: "@matfire/janitor@next",
      janitor_version: "next",
      tracked_paths: ["src/**", 'a/quoted-"path"/**', "line\nbreak/**", "windows\\path/**"],
    });

    expect(rendered.config)
      .toBe(`# Janitor CLI version used by the generated GitHub Actions workflow.
version = "next"

[review]
# Append per-run model token usage and estimated cost to the main review comment.
track_spend = false

# Run a review when at least one changed path matches one of these glob patterns.
tracked_paths = [
  "src/**",
  "a/quoted-\\"path\\"/**",
  "line\\nbreak/**",
  "windows\\\\path/**"
]
`);
    expect(rendered.workflow).toContain('run: npx --yes "@matfire/janitor@next" review');
    expect(rendered.workflow).toContain("contents: read");
    expect(rendered.workflow).toContain("pull-requests: write");
    expect(rendered.workflow).not.toContain("issues: write");
    expect(rendered.workflow).toContain("group: janitor-${{ github.event.pull_request.number }}");
    expect(rendered.workflow).toContain("cancel-in-progress: true");
    expect(rendered.workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(rendered.workflow).toContain("fetch-depth: 0");
    expect(rendered.workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(rendered.workflow).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(rendered.workflow).toContain("JANITOR_VERBOSE: ${{ vars.JANITOR_VERBOSE }}");
    expect(rendered.workflow).toContain("JANITOR_MODEL: ${{ secrets.JANITOR_MODEL }}");
    expect(rendered.workflow).toContain("JANITOR_PROVIDER: ${{ secrets.JANITOR_PROVIDER }}");
    expect(rendered.workflow).toContain(
      "JANITOR_PROVIDER_KEY: ${{ secrets.JANITOR_PROVIDER_KEY }}",
    );
    expect(rendered.workflow).not.toContain("create-github-app-token");
    expect(rendered.workflow).not.toContain("{= janitor_package");
  });

  it("renders a workflow that authenticates as a GitHub App", async () => {
    const rendered = await renderInitFiles({
      github_app: true,
      janitor_package: "@matfire/janitor@latest",
      janitor_version: "latest",
      tracked_paths: ["**"],
    });

    expect(rendered.workflow).toContain(`      - name: Create GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: \${{ vars.JANITOR_APP_CLIENT_ID }}
          private-key: \${{ secrets.JANITOR_APP_PRIVATE_KEY }}
          repositories: \${{ github.event.repository.name }}
          permission-contents: read
          permission-pull-requests: write
      - name: Set up Node.js
`);
    expect(rendered.workflow).toContain(`        env:
          GITHUB_TOKEN: \${{ steps.app-token.outputs.token }}
          JANITOR_VERBOSE: \${{ vars.JANITOR_VERBOSE }}
`);
    expect(rendered.workflow).not.toContain("secrets.GITHUB_TOKEN");
  });

  it("fails when a strict template variable is missing", async () => {
    await expect(
      renderInitFiles({
        janitor_version: "latest",
        tracked_paths: ["**"],
        github_app: false,
      } as never),
    ).rejects.toThrow(/janitor_package/u);
  });
});

describe("init filesystem behavior", () => {
  it("creates both targets in a fresh directory", async () => {
    const cwd = await createTemporaryDirectory();
    const prompts = createPrompts();
    const reports: InitTargetResult[] = [];

    const result = await init(
      { ...completeOptions, janitorVersion: "beta" },
      { cwd, prompts, report: (target) => reports.push(target) },
    );

    expect(result).toEqual({
      cancelled: false,
      targets: [
        { path: "janitor.toml", status: "created" },
        { path: ".github/workflows/janitor.yml", status: "created" },
      ],
    });
    expect(reports).toEqual(result.targets);
    expect(await readTarget(cwd, "janitor.toml")).toContain('version = "beta"');
    expect(await readTarget(cwd, "janitor.toml")).toContain("track_spend = false");
    expect(await readTarget(cwd, "janitor.toml")).toContain('  "**"');
    expect(await readTarget(cwd, ".github/workflows/janitor.yml")).toContain(
      'npx --yes "@matfire/janitor@beta" review',
    );
    expect(prompts.confirmOverwrite).not.toHaveBeenCalled();
  });

  it("collects an omitted version from prompts", async () => {
    const cwd = await createTemporaryDirectory();
    const prompts = createPrompts({ getJanitorVersion: async () => "next" });

    await init(
      { force: false, githubIdentity: "github-actions", janitorVersion: undefined },
      { cwd, prompts },
    );

    expect(prompts.getJanitorVersion).toHaveBeenCalledOnce();
    expect(await readTarget(cwd, "janitor.toml")).toContain('version = "next"');
    expect(await readTarget(cwd, "janitor.toml")).toContain('  "**"');
  });

  it("collects an omitted GitHub identity from prompts", async () => {
    const cwd = await createTemporaryDirectory();
    const prompts = createPrompts({ getGitHubIdentity: async () => "github-app" });

    await init({ ...completeOptions, githubIdentity: undefined }, { cwd, prompts });

    expect(prompts.getGitHubIdentity).toHaveBeenCalledOnce();
    expect(await readTarget(cwd, ".github/workflows/janitor.yml")).toContain(
      "GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}",
    );
  });

  it("does not prompt for a GitHub identity supplied as an option", async () => {
    const cwd = await createTemporaryDirectory();
    const prompts = createPrompts();

    await init(completeOptions, { cwd, prompts });

    expect(prompts.getGitHubIdentity).not.toHaveBeenCalled();
    expect(await readTarget(cwd, ".github/workflows/janitor.yml")).toContain(
      "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    );
  });

  it.each([
    ["version", { janitorVersion: undefined }, { getJanitorVersion: async () => undefined }],
    ["identity", { githubIdentity: undefined }, { getGitHubIdentity: async () => undefined }],
  ] satisfies Array<[string, Partial<InitOptions>, Partial<InitPromptBoundary>]>)(
    "writes nothing when the %s prompt is cancelled",
    async (_name, options, overrides) => {
      const cwd = await createTemporaryDirectory();
      const prompts = createPrompts(overrides);

      const result = await init({ ...completeOptions, ...options }, { cwd, prompts });

      expect(result).toEqual({ cancelled: true, targets: [] });
      expect(prompts.reportCancellation).toHaveBeenCalledOnce();
      await expectTargetNotToExist(cwd, "janitor.toml");
      await expectTargetNotToExist(cwd, ".github/workflows/janitor.yml");
    },
  );

  it("leaves byte-identical targets unchanged without prompting", async () => {
    const cwd = await createTemporaryDirectory();
    const prompts = createPrompts();

    await init(completeOptions, { cwd, prompts });
    prompts.confirmOverwrite.mockClear();
    const result = await init(completeOptions, { cwd, prompts });

    expect(result.targets).toEqual([
      { path: "janitor.toml", status: "unchanged" },
      { path: ".github/workflows/janitor.yml", status: "unchanged" },
    ]);
    expect(prompts.confirmOverwrite).not.toHaveBeenCalled();
  });

  it("prompts for and applies each file collision independently", async () => {
    const cwd = await createTemporaryDirectory();
    await writeTarget(cwd, "janitor.toml", "existing config\n");
    await writeTarget(cwd, ".github/workflows/janitor.yml", "existing workflow\n");
    const prompts = createPrompts();
    prompts.confirmOverwrite.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const result = await init(completeOptions, { cwd, prompts });

    expect(prompts.confirmOverwrite).toHaveBeenNthCalledWith(1, "janitor.toml");
    expect(prompts.confirmOverwrite).toHaveBeenNthCalledWith(2, ".github/workflows/janitor.yml");
    expect(result.targets).toEqual([
      { path: "janitor.toml", status: "skipped" },
      { path: ".github/workflows/janitor.yml", status: "overwritten" },
    ]);
    expect(await readTarget(cwd, "janitor.toml")).toBe("existing config\n");
    expect(await readTarget(cwd, ".github/workflows/janitor.yml")).toContain("name: Janitor");
  });

  it("does not apply an earlier collision decision when a later prompt is cancelled", async () => {
    const cwd = await createTemporaryDirectory();
    await writeTarget(cwd, "janitor.toml", "existing config\n");
    await writeTarget(cwd, ".github/workflows/janitor.yml", "existing workflow\n");
    const prompts = createPrompts();
    prompts.confirmOverwrite.mockResolvedValueOnce(true).mockResolvedValueOnce(undefined);

    const result = await init(completeOptions, { cwd, prompts });

    expect(result).toEqual({ cancelled: true, targets: [] });
    expect(prompts.reportCancellation).toHaveBeenCalledOnce();
    expect(await readTarget(cwd, "janitor.toml")).toBe("existing config\n");
    expect(await readTarget(cwd, ".github/workflows/janitor.yml")).toBe("existing workflow\n");
  });

  it("force-overwrites both changed targets without prompting", async () => {
    const cwd = await createTemporaryDirectory();
    await writeTarget(cwd, "janitor.toml", "existing config\n");
    await writeTarget(cwd, ".github/workflows/janitor.yml", "existing workflow\n");
    const prompts = createPrompts();

    const result = await init({ ...completeOptions, force: true }, { cwd, prompts });

    expect(result.targets).toEqual([
      { path: "janitor.toml", status: "overwritten" },
      { path: ".github/workflows/janitor.yml", status: "overwritten" },
    ]);
    expect(prompts.confirmOverwrite).not.toHaveBeenCalled();
    expect(await readTarget(cwd, "janitor.toml")).toContain('version = "latest"');
    expect(await readTarget(cwd, ".github/workflows/janitor.yml")).toContain("name: Janitor");
  });
});
