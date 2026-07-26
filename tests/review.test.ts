import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewPrompt } from "#/review/agent";
import { loadReviewConfig, shouldRunReview } from "#/review/config";
import { collectReviewDiff, parseCommentableLines, parseNameStatus } from "#/review/git";
import {
  FINDING_MARKER,
  GENERAL_REVIEW_MARKER,
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  renderGeneralComment,
} from "#/review/markers";
import { executeReview } from "#/review/orchestrator";
import { readPullRequestContext, readReviewEnvironment } from "#/review/runtime";
import type {
  GitCommandBoundary,
  GitHubReviewBoundary,
  ModelReviewResult,
  PullRequestContext,
  ReviewAgentBoundary,
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "janitor-review-"));
  temporaryDirectories.push(directory);
  return directory;
}

function reviewGit(path = "src/a.ts"): GitCommandBoundary {
  return {
    async run(args) {
      if (args[0] === "rev-parse") return "head-sha\n";
      if (args[0] === "merge-base") return "merge-sha\n";
      if (args.includes("--name-status")) return `M\0${path}\0`;
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

function githubBoundary(
  options: {
    previous?: boolean;
    general?: boolean;
  } = {},
): GitHubReviewBoundary & Record<string, ReturnType<typeof vi.fn>> {
  const previous = options.previous ?? false;
  return {
    listGeneralComments: vi.fn(async () =>
      options.general
        ? [
            {
              id: 9,
              body: GENERAL_REVIEW_MARKER,
              author: "github-actions[bot]",
            },
          ]
        : [],
    ),
    listReviewThreads: vi.fn(async () =>
      previous
        ? [
            {
              id: "thread-1",
              isResolved: false,
              isOutdated: false,
              path: "src/a.ts",
              line: 2,
              originalLine: 2,
              comments: [
                {
                  databaseId: 7,
                  body: `${FINDING_MARKER}\n**HIGH: Existing issue**`,
                  author: "github-actions[bot]",
                },
              ],
            },
          ]
        : [],
    ),
    createInlineComment: vi.fn(async () => undefined),
    resolveThread: vi.fn(async () => undefined),
    createGeneralComment: vi.fn(async () => undefined),
    updateGeneralComment: vi.fn(async () => undefined),
  } as never;
}

function agent(result: ModelReviewResult): ReviewAgentBoundary {
  return { run: vi.fn(async () => result) };
}

const cleanGeneral = {
  summary: "The change is focused and no actionable issues were found.",
  mermaid: "flowchart LR\n  A[Caller] --> B[Changed code]",
  confidence: 4,
  confidenceReason: "All changed files and their direct callers were inspected.",
};

async function execute(modelResult: ModelReviewResult, github = githubBoundary()) {
  return executeReview({
    cwd: "/repo",
    context,
    git: reviewGit(),
    github,
    agent: agent(modelResult),
    configLoader: async () => ({ trackedPaths: ["src/**"] }),
  });
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

  it("loads tracked globs and treats them as a review gate", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "janitor.toml"),
      'version = "latest"\n[review]\ntracked_paths = ["src/**", ".github/**"]\n',
    );
    await expect(loadReviewConfig(directory)).resolves.toEqual({
      trackedPaths: ["src/**", ".github/**"],
    });
    expect(
      shouldRunReview(
        [
          {
            path: "docs/readme.md",
            previousPath: "src/readme.ts",
            status: "renamed",
            patch: "",
            commentableLines: { left: new Set(), right: new Set() },
          },
        ],
        ["src/**"],
      ),
    ).toBe(true);
  });

  it("rejects malformed review configuration", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { recursive: true });
    const configPath = join(directory, "janitor.toml");
    await writeFile(configPath, "version = 'latest'\n");
    await expect(loadReviewConfig(directory)).rejects.toThrow(/review must be an object/u);

    await writeFile(configPath, "version = 'latest'\n[review]\ntracked_paths = ['']\n");
    await expect(loadReviewConfig(directory)).rejects.toThrow(
      /tracked_paths\[0\] must be non-empty/u,
    );
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
    const git = reviewGit("src/a.ts");
    const diff = await collectReviewDiff("/repo", context, git);
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

describe("Janitor markers and prompt", () => {
  it("only recognizes marked output authored by the authenticated viewer", () => {
    expect(
      findJanitorGeneralComment([
        { id: 1, body: GENERAL_REVIEW_MARKER, author: "someone" },
        { id: 2, body: GENERAL_REVIEW_MARKER, author: "janitor[bot]" },
      ]),
    ).toMatchObject({ id: 2 });
    expect(
      findOpenJanitorFindings([
        {
          id: "thread",
          isResolved: false,
          isOutdated: true,
          path: "a.ts",
          line: null,
          originalLine: 4,
          comments: [{ databaseId: 2, body: `${FINDING_MARKER}\nissue`, author: "janitor[bot]" }],
        },
      ]),
    ).toMatchObject([{ threadId: "thread", body: "issue", isOutdated: true }]);
    expect(
      findOpenJanitorFindings([
        {
          id: "user-thread",
          isResolved: false,
          isOutdated: false,
          path: "a.ts",
          line: 2,
          originalLine: 2,
          comments: [
            { databaseId: 3, body: "User finding", author: "user" },
            { databaseId: 4, body: FINDING_MARKER, author: "janitor[bot]" },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("renders one marked general comment with diagram and confidence", () => {
    const body = renderGeneralComment(cleanGeneral, {
      newFindings: 0,
      stillOpen: 0,
      fixed: 0,
    });
    expect(body).toContain(GENERAL_REVIEW_MARKER);
    expect(body).toContain("```mermaid");
    expect(body).toContain("Confidence: 4/5");
  });

  it("instructs the agent to map usages and explicitly disposition old threads", () => {
    const prompt = buildReviewPrompt({
      cwd: "/repo",
      context,
      diff: { mergeBase: "merge", headSha: "head-sha", files: [] },
      previousFindings: [
        {
          threadId: "thread-1",
          commentId: 1,
          path: "a.ts",
          line: 2,
          originalLine: 2,
          isOutdated: false,
          body: "issue",
        },
      ],
    });
    expect(prompt).toContain("imports");
    expect(prompt).toContain("thread-1");
    expect(prompt).toContain("premature optimizations");
    expect(prompt).toContain("submit_review exactly once");
  });
});

describe("review reconciliation", () => {
  it("posts new inline findings and creates the canonical general comment", async () => {
    const github = githubBoundary();
    const result = await execute(
      {
        findings: [
          {
            title: "Incorrect replacement",
            body: "This changes the behavior unexpectedly.",
            severity: "high",
            path: "src/a.ts",
            side: "RIGHT",
            line: 2,
          },
        ],
        dispositions: [],
        general: cleanGeneral,
      },
      github,
    );
    expect(result).toEqual({ skipped: false, newFindings: 1, stillOpen: 0, fixed: 0 });
    expect(github.createInlineComment).toHaveBeenCalledOnce();
    expect(github.createInlineComment.mock.calls[0]?.[1]).toContain(FINDING_MARKER);
    expect(github.createGeneralComment).toHaveBeenCalledOnce();
    expect(github.updateGeneralComment).not.toHaveBeenCalled();
  });

  it("leaves a reproduced thread open without posting a duplicate", async () => {
    const github = githubBoundary({ previous: true, general: true });
    await execute(
      {
        findings: [],
        dispositions: [{ threadId: "thread-1", status: "still_present" }],
        general: cleanGeneral,
      },
      github,
    );
    expect(github.createInlineComment).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
    expect(github.updateGeneralComment).toHaveBeenCalledWith(9, expect.any(String));
  });

  it("resolves an explicitly fixed old finding and updates the general comment", async () => {
    const github = githubBoundary({ previous: true, general: true });
    await execute(
      {
        findings: [],
        dispositions: [
          { threadId: "thread-1", status: "fixed", reason: "The unsafe branch was removed." },
        ],
        general: cleanGeneral,
      },
      github,
    );
    expect(github.resolveThread).toHaveBeenCalledWith("thread-1");
    expect(github.updateGeneralComment).toHaveBeenCalledOnce();
  });

  it("performs no mutations when model output is incomplete or has an invalid location", async () => {
    const github = githubBoundary({ previous: true });
    await expect(
      execute(
        {
          findings: [
            {
              title: "Issue",
              body: "Impact",
              severity: "high",
              path: "src/a.ts",
              side: "RIGHT",
              line: 99,
            },
          ],
          dispositions: [],
          general: cleanGeneral,
        },
        github,
      ),
    ).rejects.toThrow(/omitted dispositions|not a changed line/u);
    expect(github.createInlineComment).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
    expect(github.createGeneralComment).not.toHaveBeenCalled();
  });

  it("skips before GitHub or model access when tracked paths do not match", async () => {
    const github = githubBoundary();
    const reviewAgent = agent({ findings: [], dispositions: [], general: cleanGeneral });
    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit("docs/a.md"),
      github,
      agent: reviewAgent,
      configLoader: async () => ({ trackedPaths: ["src/**"] }),
    });
    expect(result.skipped).toBe(true);
    expect(github.listGeneralComments).not.toHaveBeenCalled();
    expect(reviewAgent.run).not.toHaveBeenCalled();
  });
});
