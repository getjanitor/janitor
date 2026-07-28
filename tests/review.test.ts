import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewPrompt } from "#/review/agent";
import {
  fileMatchesReviewPaths,
  filterReviewDiff,
  loadReviewConfig,
  type DisabledFindingsPolicy,
  type ReviewConfig,
} from "#/review/config";
import { collectReviewDiff, parseCommentableLines, parseNameStatus } from "#/review/git";
import {
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  findingMarker,
  generalReviewMarker,
  renderGeneralComment,
} from "#/review/markers";
import { executeReview } from "#/review/orchestrator";
import { readPullRequestContext, readReviewEnvironment } from "#/review/runtime";
import type {
  ChangedFile,
  GitCommandBoundary,
  GitHubReviewBoundary,
  ModelReviewResult,
  PullRequestContext,
  ReviewAgentBoundary,
  ReviewAgentInput,
  ReviewDiff,
  ReviewType,
} from "#/review/types";

const temporaryDirectories: string[] = [];

const context: PullRequestContext = {
  repository: "owner/repo",
  owner: "owner",
  repo: "repo",
  number: 12,
  baseRef: "main",
  baseSha: "base-sha",
  headRef: "feature",
  headSha: "head-sha",
};

const cleanGeneral = {
  summary: "The scoped change is focused and no actionable issues were found.",
  mermaid: "flowchart LR\n  A[Caller] --> B[Changed code]",
  confidence: 4,
  confidenceReason: "All scoped files and their direct callers were inspected.",
};

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "janitor-review-"));
  temporaryDirectories.push(directory);
  return directory;
}

function reviewGit(paths: string | string[] = "src/a.ts"): GitCommandBoundary {
  const changedPaths = typeof paths === "string" ? [paths] : paths;
  return {
    async run(args) {
      if (args[0] === "rev-parse") return "head-sha\n";
      if (args[0] === "merge-base") return "merge-sha\n";
      if (args.includes("--name-status")) {
        return changedPaths.map((path) => `M\0${path}\0`).join("");
      }
      const path = args.at(-1)!;
      if (args.includes("--unified=0")) {
        return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -2 +2 @@\n-old\n+new\n`;
      }
      if (args.includes("--unified=20")) {
        return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n`;
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    },
  };
}

interface PreviousFindingFixture {
  reviewType: ReviewType;
  path: string;
  threadId?: string;
  line?: number | null;
}

function githubBoundary(
  options: {
    previous?: PreviousFindingFixture[];
    general?: ReviewType[];
  } = {},
): GitHubReviewBoundary & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listGeneralComments: vi.fn(async () =>
      (options.general ?? []).map((reviewType, index) => ({
        id: 10 + index,
        body: generalReviewMarker(reviewType),
        author: "github-actions[bot]",
      })),
    ),
    listReviewThreads: vi.fn(async () =>
      (options.previous ?? []).map((finding, index) => ({
        id: finding.threadId ?? `thread-${index + 1}`,
        isResolved: false,
        isOutdated: false,
        path: finding.path,
        line: finding.line === undefined ? 2 : finding.line,
        originalLine: 2,
        comments: [
          {
            databaseId: 20 + index,
            body: `${findingMarker(finding.reviewType)}\n**HIGH: Existing issue**`,
            author: "github-actions[bot]",
          },
        ],
      })),
    ),
    createInlineComment: vi.fn(async () => undefined),
    resolveThread: vi.fn(async () => undefined),
    createGeneralComment: vi.fn(async () => undefined),
    updateGeneralComment: vi.fn(async () => undefined),
  } as never;
}

function modelResult(overrides: Partial<ModelReviewResult> = {}): ModelReviewResult {
  return {
    findings: [],
    dispositions: [],
    general: cleanGeneral,
    ...overrides,
  };
}

function agent(
  handler: (input: ReviewAgentInput) => ModelReviewResult | Promise<ModelReviewResult>,
): ReviewAgentBoundary & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(handler) } as never;
}

function reviewConfig(
  options: {
    codePaths?: string[];
    securityPaths?: string[];
    codePolicy?: DisabledFindingsPolicy;
    securityPolicy?: DisabledFindingsPolicy;
  } = {},
): ReviewConfig {
  return {
    code: {
      paths: options.codePaths ?? ["src/**"],
      disabledFindings: options.codePolicy ?? "leave_open",
    },
    security: {
      paths: options.securityPaths ?? [],
      disabledFindings: options.securityPolicy ?? "leave_open",
    },
  };
}

async function runReview(options: {
  git?: GitCommandBoundary;
  github?: ReturnType<typeof githubBoundary>;
  reviewAgent: ReviewAgentBoundary;
  config?: ReviewConfig;
}) {
  return executeReview({
    cwd: "/repo",
    context,
    git: options.git ?? reviewGit(),
    github: options.github ?? githubBoundary(),
    agent: options.reviewAgent,
    configLoader: async () => options.config ?? reviewConfig(),
  });
}

function changedFile(path: string, previousPath?: string): ChangedFile {
  return {
    path,
    previousPath,
    status: previousPath === undefined ? "modified" : "renamed",
    patch: "",
    commentableLines: { left: new Set([2]), right: new Set([2]) },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
  vi.restoreAllMocks();
});

describe("review runtime and configuration", () => {
  it("validates required environment values and supplies API defaults", () => {
    expect(
      readReviewEnvironment({
        GITHUB_TOKEN: "token",
        GITHUB_EVENT_PATH: "/event.json",
        GITHUB_REPOSITORY: "owner/repo",
        JANITOR_PROVIDER: "provider",
        JANITOR_PROVIDER_KEY: "key",
        JANITOR_MODEL: "model",
      }),
    ).toMatchObject({
      githubApiUrl: "https://api.github.com",
      githubGraphqlUrl: "https://api.github.com/graphql",
    });
    expect(() => readReviewEnvironment({})).toThrow(/GITHUB_TOKEN/u);
  });

  it("reads a same-repository pull request and rejects fork events", async () => {
    const directory = await temporaryDirectory();
    const eventPath = join(directory, "event.json");
    const event = {
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 12,
        base: { ref: "main", sha: "base", repo: { full_name: "owner/repo" } },
        head: { ref: "feature", sha: "head", repo: { full_name: "owner/repo" } },
      },
    };
    await writeFile(eventPath, JSON.stringify(event));
    await expect(readPullRequestContext(eventPath, "owner/repo")).resolves.toMatchObject({
      number: 12,
      baseRef: "main",
      headSha: "head",
    });

    event.pull_request.head.repo.full_name = "fork/repo";
    await writeFile(eventPath, JSON.stringify(event));
    await expect(readPullRequestContext(eventPath, "owner/repo")).rejects.toThrow(
      /in this repository/u,
    );
  });

  it("loads independent paths, empty lists, policies, and omitted policy defaults", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "janitor.toml"),
      `version = "latest"
[review.code]
paths = ["src/**", ".github/**"]
disabled_findings = "review"
[review.security]
paths = []
`,
    );
    await expect(loadReviewConfig(directory)).resolves.toEqual({
      code: { paths: ["src/**", ".github/**"], disabledFindings: "review" },
      security: { paths: [], disabledFindings: "leave_open" },
    });
  });

  it("rejects missing sections, empty patterns, invalid policies, and old configuration", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "janitor.toml");
    await writeFile(configPath, "version = 'latest'\n[review]\ntracked_paths = ['src/**']\n");
    await expect(loadReviewConfig(directory)).rejects.toThrow(/review\.code must be an object/u);

    await writeFile(
      configPath,
      "version = 'latest'\n[review.code]\npaths = ['']\n[review.security]\npaths = []\n",
    );
    await expect(loadReviewConfig(directory)).rejects.toThrow(/paths\[0\] must be non-empty/u);

    await writeFile(
      configPath,
      "version = 'latest'\n[review.code]\npaths = []\ndisabled_findings = 'close'\n[review.security]\npaths = []\n",
    );
    await expect(loadReviewConfig(directory)).rejects.toThrow(/disabled_findings/u);
  });

  it("classifies code-only, security-only, overlapping, neither, and rename scopes", () => {
    const diff: ReviewDiff = {
      mergeBase: "merge",
      headSha: "head",
      files: [
        changedFile("src/code.ts"),
        changedFile("infra/policy.yml"),
        changedFile("shared.ts"),
        changedFile("docs/readme.md"),
        changedFile("new/location.ts", "src/old.ts"),
      ],
    };
    expect(filterReviewDiff(diff, ["src/**", "shared.ts"]).files.map((file) => file.path)).toEqual([
      "src/code.ts",
      "shared.ts",
      "new/location.ts",
    ]);
    expect(
      filterReviewDiff(diff, ["infra/**", "shared.ts"]).files.map((file) => file.path),
    ).toEqual(["infra/policy.yml", "shared.ts"]);
    expect(fileMatchesReviewPaths(diff.files[3]!, ["src/**"])).toBe(false);
  });
});

describe("git diff collection", () => {
  it("parses modified, renamed, copied, and deleted NUL-delimited paths", () => {
    expect(
      parseNameStatus("M\0a.ts\0R100\0old.ts\0new.ts\0C90\0a.ts\0copy.ts\0D\0gone.ts\0"),
    ).toEqual([
      { status: "modified", path: "a.ts" },
      { status: "renamed", previousPath: "old.ts", path: "new.ts" },
      { status: "copied", previousPath: "a.ts", path: "copy.ts" },
      { status: "deleted", path: "gone.ts" },
    ]);
  });

  it("maps replacement and deletion lines to exact right and left sides", () => {
    const lines = parseCommentableLines("@@ -3,2 +3,2 @@\n-old\n+new\n-gone\n+replacement\n");
    expect([...lines.left]).toEqual([3, 4]);
    expect([...lines.right]).toEqual([3, 4]);
  });

  it("uses the merge base, verifies HEAD, and gathers readable and location patches", async () => {
    const diff = await collectReviewDiff("/repo", context, reviewGit());
    expect(diff.mergeBase).toBe("merge-sha");
    expect(diff.files[0]?.commentableLines.right.has(2)).toBe(true);
    expect(diff.files[0]?.commentableLines.left.has(2)).toBe(true);
    expect(diff.files[0]?.patch).toContain("before");
  });

  it("includes both rename paths so Git preserves rename-aware line locations", async () => {
    const calls: string[][] = [];
    const git: GitCommandBoundary = {
      async run(args) {
        calls.push(args);
        if (args[0] === "rev-parse") return "head-sha\n";
        if (args[0] === "merge-base") return "merge-sha\n";
        if (args.includes("--name-status")) return "R090\0old.ts\0new.ts\0";
        return "diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -2 +2 @@\n-old\n+new\n";
      },
    };

    const diff = await collectReviewDiff("/repo", context, git);
    expect(diff.files[0]).toMatchObject({
      status: "renamed",
      previousPath: "old.ts",
      path: "new.ts",
    });
    const patchCalls = calls.filter(
      (args) => args[0] === "diff" && !args.includes("--name-status"),
    );
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls.every((args) => args.slice(-2).join(" ") === "old.ts new.ts")).toBe(true);
  });

  it("rejects a checkout that is not at the pull-request head", async () => {
    const git = reviewGit();
    const mismatched: GitCommandBoundary = {
      run: async (args, cwd) => (args[0] === "rev-parse" ? "other-head\n" : git.run(args, cwd)),
    };
    await expect(collectReviewDiff("/repo", context, mismatched)).rejects.toThrow(
      /does not match/u,
    );
  });
});

describe("typed Janitor markers and prompts", () => {
  it("recognizes exact typed bot markers and ignores user roots and untyped markers", () => {
    expect(
      findJanitorGeneralComment(
        [
          { id: 1, body: generalReviewMarker("code"), author: "someone" },
          { id: 2, body: "<!-- janitor:general-review:v1 -->", author: "janitor[bot]" },
          { id: 3, body: generalReviewMarker("code"), author: "janitor[bot]" },
        ],
        "code",
      ),
    ).toMatchObject({ id: 3 });
    expect(
      findOpenJanitorFindings([
        {
          id: "security-thread",
          isResolved: false,
          isOutdated: true,
          path: "a.ts",
          line: null,
          originalLine: 4,
          comments: [
            {
              databaseId: 2,
              body: `${findingMarker("security")}\nissue`,
              author: "janitor[bot]",
            },
          ],
        },
        {
          id: "user-thread",
          isResolved: false,
          isOutdated: false,
          path: "a.ts",
          line: 2,
          originalLine: 2,
          comments: [
            { databaseId: 3, body: "User finding", author: "user" },
            {
              databaseId: 4,
              body: findingMarker("code"),
              author: "janitor[bot]",
            },
          ],
        },
      ]),
    ).toMatchObject([
      { threadId: "security-thread", reviewType: "security", body: "issue", isOutdated: true },
    ]);
  });

  it("renders separate marked general comments", () => {
    const codeBody = renderGeneralComment("code", cleanGeneral, {
      newFindings: 0,
      stillOpen: 0,
      fixed: 0,
      configurationResolved: 0,
    });
    const securityBody = renderGeneralComment("security", cleanGeneral, {
      newFindings: 0,
      stillOpen: 0,
      fixed: 0,
      configurationResolved: 0,
    });
    expect(codeBody).toContain(generalReviewMarker("code"));
    expect(codeBody).toContain("## Janitor code review");
    expect(securityBody).toContain(generalReviewMarker("security"));
    expect(securityBody).toContain("## Janitor security review");
    expect(codeBody).toContain("Confidence: 4/5");
  });

  it("builds distinct scoped prompts and supports disposition-only runs", () => {
    const baseInput: ReviewAgentInput = {
      reviewType: "code",
      cwd: "/repo",
      context,
      diff: { mergeBase: "merge", headSha: "head-sha", files: [] },
      previousFindings: [
        {
          reviewType: "code",
          threadId: "thread-1",
          commentId: 1,
          path: "a.ts",
          line: 2,
          originalLine: 2,
          isOutdated: false,
          body: "issue",
        },
      ],
    };
    const codePrompt = buildReviewPrompt(baseInput);
    const securityPrompt = buildReviewPrompt({
      ...baseInput,
      reviewType: "security",
      previousFindings: [],
    });
    expect(codePrompt).toContain("code-quality issues");
    expect(codePrompt).toContain("report security concerns in this run");
    expect(codePrompt).toContain("thread-1");
    expect(codePrompt).toContain("disposition-only");
    expect(codePrompt).toContain("submit_review exactly once");
    expect(securityPrompt).toContain("authentication or authorization");
    expect(securityPrompt).toContain("security issues");
    expect(securityPrompt).not.toContain("premature optimizations");
  });
});

describe("typed review orchestration", () => {
  it("runs separate agents over code-only, security-only, and overlapping files", async () => {
    const reviewAgent = agent(() => modelResult());
    const result = await runReview({
      git: reviewGit(["src/code.ts", "infra/policy.yml", "shared.ts", "docs/readme.md"]),
      reviewAgent,
      config: reviewConfig({
        codePaths: ["src/**", "shared.ts"],
        securityPaths: ["infra/**", "shared.ts"],
      }),
    });

    expect(reviewAgent.run).toHaveBeenCalledTimes(2);
    const inputs = reviewAgent.run.mock.calls.map((call) => call[0] as ReviewAgentInput);
    expect(
      inputs.find((input) => input.reviewType === "code")?.diff.files.map((file) => file.path),
    ).toEqual(["src/code.ts", "shared.ts"]);
    expect(
      inputs.find((input) => input.reviewType === "security")?.diff.files.map((file) => file.path),
    ).toEqual(["infra/policy.yml", "shared.ts"]);
    expect(result.code.skipped).toBe(false);
    expect(result.security.skipped).toBe(false);
  });

  it("posts typed findings and creates one general comment for each type", async () => {
    const github = githubBoundary();
    const reviewAgent = agent((input) =>
      modelResult({
        findings: [
          {
            reviewType: input.reviewType,
            title: `${input.reviewType} issue`,
            body: "This has a concrete impact.",
            severity: "high",
            path: "src/a.ts",
            side: "RIGHT",
            line: 2,
          },
        ],
      }),
    );
    const result = await runReview({
      github,
      reviewAgent,
      config: reviewConfig({ codePaths: ["src/**"], securityPaths: ["src/**"] }),
    });

    expect(result.code.newFindings).toBe(1);
    expect(result.security.newFindings).toBe(1);
    expect(github.createInlineComment).toHaveBeenCalledTimes(2);
    const inlineBodies = github.createInlineComment.mock.calls.map((call) => String(call[1]));
    expect(inlineBodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(findingMarker("code")),
        expect.stringContaining(findingMarker("security")),
      ]),
    );
    expect(github.createGeneralComment).toHaveBeenCalledTimes(2);
    const generalBodies = github.createGeneralComment.mock.calls.map((call) => String(call[0]));
    expect(generalBodies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("## Janitor code review"),
        expect.stringContaining("## Janitor security review"),
      ]),
    );
  });

  it("updates only the matching typed general comment and resolves model-fixed findings", async () => {
    const github = githubBoundary({
      previous: [{ reviewType: "code", path: "src/a.ts", threadId: "code-thread" }],
      general: ["code", "security"],
    });
    const reviewAgent = agent((input) =>
      modelResult({
        dispositions:
          input.reviewType === "code"
            ? [{ threadId: "code-thread", status: "fixed", reason: "Removed." }]
            : [],
      }),
    );
    await runReview({
      github,
      reviewAgent,
      config: reviewConfig({ codePaths: ["src/**"], securityPaths: ["src/**"] }),
    });

    expect(github.resolveThread).toHaveBeenCalledWith("code-thread");
    expect(github.updateGeneralComment).toHaveBeenCalledWith(
      10,
      expect.stringContaining("Janitor code review"),
    );
    expect(github.updateGeneralComment).toHaveBeenCalledWith(
      11,
      expect.stringContaining("Janitor security review"),
    );
  });

  it("preserves disabled findings under leave_open while reviewing matched files", async () => {
    const github = githubBoundary({
      previous: [{ reviewType: "code", path: "docs/old.md", threadId: "left-open" }],
    });
    const reviewAgent = agent((input) => {
      expect(input.previousFindings).toEqual([]);
      return modelResult();
    });
    const result = await runReview({ github, reviewAgent });

    expect(result.code.leftOpen).toBe(1);
    expect(github.resolveThread).not.toHaveBeenCalled();
  });

  it("runs a disposition-only review for disabled findings under review policy", async () => {
    const github = githubBoundary({
      previous: [{ reviewType: "code", path: "docs/old.md", threadId: "review-old" }],
    });
    const reviewAgent = agent((input) => {
      expect(input.reviewType).toBe("code");
      expect(input.diff.files).toEqual([]);
      expect(input.previousFindings.map((finding) => finding.threadId)).toEqual(["review-old"]);
      return modelResult({
        dispositions: [{ threadId: "review-old", status: "still_present" }],
      });
    });
    const result = await runReview({
      github,
      reviewAgent,
      config: reviewConfig({ codePaths: [], codePolicy: "review" }),
    });

    expect(reviewAgent.run).toHaveBeenCalledOnce();
    expect(result.code.stillOpen).toBe(1);
    expect(github.createGeneralComment).toHaveBeenCalledOnce();
    expect(github.resolveThread).not.toHaveBeenCalled();
  });

  it("automatically resolves disabled findings under resolve policy without an agent", async () => {
    const github = githubBoundary({
      previous: [{ reviewType: "code", path: "docs/old.md", threadId: "resolve-old" }],
    });
    const reviewAgent = agent(() => modelResult());
    const result = await runReview({
      github,
      reviewAgent,
      config: reviewConfig({ codePaths: [], codePolicy: "resolve" }),
    });

    expect(reviewAgent.run).not.toHaveBeenCalled();
    expect(github.resolveThread).toHaveBeenCalledWith("resolve-old");
    expect(github.createGeneralComment).not.toHaveBeenCalled();
    expect(result.code).toMatchObject({ skipped: false, configurationResolved: 1 });
  });

  it("allows an empty list to disable one type while the other runs", async () => {
    const reviewAgent = agent(() => modelResult());
    const result = await runReview({
      reviewAgent,
      config: reviewConfig({ codePaths: [], securityPaths: ["src/**"] }),
    });
    expect(reviewAgent.run).toHaveBeenCalledOnce();
    expect((reviewAgent.run.mock.calls[0]![0] as ReviewAgentInput).reviewType).toBe("security");
    expect(result.code.skipped).toBe(true);
    expect(result.security.skipped).toBe(false);
  });

  it("skips before GitHub and model access when neither type has work", async () => {
    const github = githubBoundary();
    const reviewAgent = agent(() => modelResult());
    const result = await runReview({
      git: reviewGit("docs/a.md"),
      github,
      reviewAgent,
      config: reviewConfig({ codePaths: ["src/**"], securityPaths: ["infra/**"] }),
    });
    expect(result.skipped).toBe(true);
    expect(github.listGeneralComments).not.toHaveBeenCalled();
    expect(reviewAgent.run).not.toHaveBeenCalled();
  });

  it("performs no GitHub mutation when either agent output fails validation", async () => {
    const github = githubBoundary({
      previous: [{ reviewType: "code", path: "docs/old.md", threadId: "deferred-resolve" }],
    });
    const reviewAgent = agent((input) =>
      input.reviewType === "code"
        ? modelResult()
        : modelResult({
            findings: [
              {
                reviewType: "security",
                title: "Invalid location",
                body: "Impact",
                severity: "high",
                path: "src/a.ts",
                side: "RIGHT",
                line: 99,
              },
            ],
          }),
    );

    await expect(
      runReview({
        github,
        reviewAgent,
        config: reviewConfig({
          codePaths: ["src/**"],
          securityPaths: ["src/**"],
          codePolicy: "resolve",
        }),
      }),
    ).rejects.toThrow(/not a changed line/u);
    expect(github.createInlineComment).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
    expect(github.createGeneralComment).not.toHaveBeenCalled();
    expect(github.updateGeneralComment).not.toHaveBeenCalled();
  });
});
