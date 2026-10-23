import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { review } from "#/commands/review";
import {
  buildReviewPrompt,
  formatAgentActivity,
  hasAvailableModelPricing,
  reportAgentEventUsage,
} from "#/review/agent";
import { loadReviewConfig, shouldRunReview } from "#/review/config";
import { collectReviewDiff, parseCommentableLines, parseNameStatus } from "#/review/git";
import {
  FINDING_MARKER,
  GENERAL_REVIEW_MARKER,
  REVIEW_STATUS_MARKER,
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  reconcileReviewDescription,
  renderGeneralComment,
  renderGeneralCommentStatus,
  renderReviewDescriptionStatus,
} from "#/review/markers";
import { requireValidModelText } from "#/review/model_result";
import { executeReview } from "#/review/orchestrator";
import {
  MAX_SPEND_ENTRIES,
  appendSpendEntry,
  completedSpendEntry,
  createReviewUsageAccumulator,
  formatEstimatedCost,
  parseSpendHistory,
  renderSpendHistory,
  trimSpendHistoryToFit,
} from "#/review/spend";
import { readPullRequestContext, readReviewEnvironment } from "#/review/runtime";
import type {
  GitCommandBoundary,
  GitHubReviewBoundary,
  ModelReviewResult,
  PullRequestContext,
  ReviewAgentBoundary,
  ReviewEnvironment,
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
    generalBody?: string;
    body?: string;
  } = {},
): GitHubReviewBoundary & Record<string, ReturnType<typeof vi.fn>> {
  const previous = options.previous ?? false;
  let body = options.body ?? "Pull request description";
  return {
    getPullRequestBody: vi.fn(async () => body),
    updatePullRequestBody: vi.fn(async (updated: string) => {
      body = updated;
    }),
    listGeneralComments: vi.fn(async () =>
      options.general
        ? [
            {
              id: 9,
              body: options.generalBody ?? GENERAL_REVIEW_MARKER,
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
    createInlineComment: vi.fn(async (): Promise<string | undefined> => "https://github.com/c/1"),
    resolveThread: vi.fn(async () => undefined),
    createGeneralComment: vi.fn(async () => 10),
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
    configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
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
      trackSpend: false,
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

  it("threads the command reporter through orchestration and the coding agent factory", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "janitor.toml"),
      'version = "latest"\n[review]\ntracked_paths = ["src/**"]\n',
    );
    const reports: string[] = [];
    const report = (message: string) => reports.push(message);
    const createAgent = vi.fn((_environment: ReviewEnvironment, progress: typeof report) => {
      expect(progress).toBe(report);
      return agent({ findings: [], dispositions: [], general: cleanGeneral });
    });

    await review(
      { verbose: true },
      {
        cwd: directory,
        environment: {
          GITHUB_TOKEN: "token",
          GITHUB_EVENT_PATH: "/unused-event.json",
          GITHUB_REPOSITORY: "owner/repo",
          JANITOR_PROVIDER: "provider",
          JANITOR_PROVIDER_KEY: "key",
          JANITOR_MODEL: "model",
        },
        readContext: async () => context,
        git: reviewGit(),
        createAgent,
        createGitHub: () => githubBoundary(),
        report,
      },
    );

    expect(createAgent).toHaveBeenCalledOnce();
    expect(reports).toContain("Starting the coding review agent.");
    expect(reports.at(-1)).toContain("Janitor review complete:");
  });

  it("keeps progress quiet by default and enables it with JANITOR_VERBOSE=1", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "janitor.toml"),
      'version = "latest"\n[review]\ntracked_paths = ["src/**"]\n',
    );
    const baseEnvironment = {
      GITHUB_TOKEN: "token",
      GITHUB_EVENT_PATH: "/unused-event.json",
      GITHUB_REPOSITORY: "owner/repo",
      JANITOR_PROVIDER: "provider",
      JANITOR_PROVIDER_KEY: "key",
      JANITOR_MODEL: "model",
    };
    const reports: string[] = [];
    const dependencies = {
      cwd: directory,
      readContext: async () => context,
      git: reviewGit(),
      createAgent: () => agent({ findings: [], dispositions: [], general: cleanGeneral }),
      createGitHub: () => githubBoundary(),
      report: (message: string) => reports.push(message),
    };

    await review({}, { ...dependencies, environment: baseEnvironment });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("Janitor review complete:");

    reports.length = 0;
    await review(
      {},
      { ...dependencies, environment: { ...baseEnvironment, JANITOR_VERBOSE: "1" } },
    );
    expect(reports).toContain("Starting the coding review agent.");
    expect(reports.at(-1)).toContain("Janitor review complete:");
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

    await writeFile(
      configPath,
      "version = 'latest'\n[review]\ntracked_paths = ['**']\ntrack_spend = 'yes'\n",
    );
    await expect(loadReviewConfig(directory)).rejects.toThrow(/track_spend must be boolean/u);
  });

  it("loads explicit spend tracking settings", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "janitor.toml");
    await writeFile(
      configPath,
      'version = "latest"\n[review]\ntracked_paths = ["**"]\ntrack_spend = true\n',
    );
    await expect(loadReviewConfig(directory)).resolves.toMatchObject({ trackSpend: true });
    await writeFile(
      configPath,
      'version = "latest"\n[review]\ntracked_paths = ["**"]\ntrack_spend = false\n',
    );
    await expect(loadReviewConfig(directory)).resolves.toMatchObject({ trackSpend: false });
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

  it("rejects every rendered Janitor marker as model-authored text", () => {
    const markers = [
      GENERAL_REVIEW_MARKER,
      FINDING_MARKER,
      renderSpendHistory([
        completedSpendEntry("head-sha", "succeeded", {
          inputTokens: 1,
          outputTokens: 2,
        }),
      ]),
      renderReviewDescriptionStatus("head-sha", "running"),
    ];

    for (const marker of markers) {
      expect(() => requireValidModelText(`Model output containing ${marker}`, "test text")).toThrow(
        /reserved Janitor marker/u,
      );
    }
  });

  it("renders and reconciles a single head-aware status block", () => {
    const running = renderReviewDescriptionStatus("head-sha", "running");
    expect(running).toContain(REVIEW_STATUS_MARKER);
    expect(running).toContain("head=head-sha");
    expect(running).toContain("👀 Janitor review in progress");

    const emptyBody = reconcileReviewDescription("", "head-sha", "running");
    expect(emptyBody).toBe(running);

    const original = "Title\n\nAuthor-written details.\n\n\n";
    const withRunning = reconcileReviewDescription(original, "head-sha", "running");
    const complete = reconcileReviewDescription(withRunning, "head-sha", "complete");
    expect(withRunning.startsWith(original)).toBe(true);
    expect(complete.startsWith(original)).toBe(true);
    expect(complete).toContain("✅ Janitor review complete");
    expect(complete.match(new RegExp(REVIEW_STATUS_MARKER, "gu"))).toHaveLength(2);
  });

  it("removes duplicate old status blocks and rejects stale terminal transitions", () => {
    const authorBody = "Author content";
    const duplicateBody = `${authorBody}\n\n${renderReviewDescriptionStatus("old-1", "failed")}\n\n${renderReviewDescriptionStatus("old-2", "running")}`;
    const current = reconcileReviewDescription(duplicateBody, "new-head", "running");
    expect(current).toContain(authorBody);
    expect(current).not.toContain("old-1");
    expect(current).not.toContain("old-2");
    expect(current.match(new RegExp(REVIEW_STATUS_MARKER, "gu"))).toHaveLength(2);

    expect(reconcileReviewDescription(current, "old-head", "complete")).toBe(current);
    expect(reconcileReviewDescription(current, "new-head", "skipped")).toContain(
      "⏭️ Janitor review skipped — no tracked paths changed",
    );
  });

  it("renders one marked general comment with diagram and confidence", () => {
    const body = renderGeneralComment(cleanGeneral, [], { stillOpen: 0, fixed: 0 });
    expect(body).toContain(GENERAL_REVIEW_MARKER);
    expect(body).toContain("```mermaid");
    expect(body).toContain("Confidence: 4/5");
    expect(body).toContain("No new findings.");
  });

  it("lists findings with severity badges and links ahead of the summary", () => {
    const body = renderGeneralComment(
      cleanGeneral,
      [
        { title: "Reviews change\nwithout updates", severity: "medium", url: "https://x/c/1" },
        { title: "Unlinked", severity: "critical" },
      ],
      { stillOpen: 2, fixed: 1 },
    );
    expect(body).toContain(
      "1. ![medium](https://img.shields.io/badge/medium-yellow) **Reviews change without updates** [►](https://x/c/1)",
    );
    expect(body).toContain(
      "2. ![critical](https://img.shields.io/badge/critical-critical) **Unlinked**\n",
    );
    expect(body).toContain("- Existing findings still open: 2\n- Fixed findings resolved: 1");
    expect(body.indexOf("### Findings")).toBeLessThan(body.indexOf("### Summary"));
  });

  it("caps long finding titles in the findings list", () => {
    const body = renderGeneralComment(cleanGeneral, [{ title: "x".repeat(500), severity: "low" }], {
      stillOpen: 0,
      fixed: 0,
    });
    expect(body).toContain(`**${"x".repeat(119)}…**`);
    expect(body).not.toContain("x".repeat(120));
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
    expect(prompt).toContain("Never reproduce a Janitor HTML marker prefix");
    expect(prompt).toContain("&lt;");
    expect(prompt).toContain("submit_review exactly once");
  });
});

describe("review spend accounting", () => {
  const pricedModel = {
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  };

  function eventUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
    };
  }

  it("aggregates assistant, tool-model, retry, and compaction usage exactly once", () => {
    const accumulator = createReviewUsageAccumulator();
    const report = (event: Parameters<typeof reportAgentEventUsage>[0]) =>
      reportAgentEventUsage(event, true, accumulator.report);
    report({
      type: "message_end",
      message: { role: "assistant", usage: eventUsage(10, 4, 3, 2) },
    } as never);
    report({
      type: "message_end",
      message: { role: "assistant", usage: eventUsage(5, 2, 1, 1), stopReason: "error" },
    } as never);
    report({
      type: "message_end",
      message: { role: "toolResult", usage: eventUsage(7, 3, 2, 1) },
    } as never);
    report({
      type: "compaction_end",
      result: { usage: eventUsage(8, 5, 4, 2) },
    } as never);
    report({ type: "agent_end", messages: [], willRetry: false } as never);

    expect(accumulator.snapshot()).toEqual({
      inputTokens: 46,
      outputTokens: 14,
      estimatedCostUsd: 0.0492,
    });
  });

  it("only publishes cost when the model catalog has a positive price", () => {
    expect(hasAvailableModelPricing(pricedModel)).toBe(true);
    expect(
      hasAvailableModelPricing({
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          tiers: [{ input: 0, output: 3, cacheRead: 0, cacheWrite: 0 }],
        },
      }),
    ).toBe(true);
    expect(
      hasAvailableModelPricing({
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBe(false);
    expect(formatEstimatedCost(0.012_345)).toBe("$0.0123");
    expect(formatEstimatedCost(undefined)).toBe("—");
  });

  it("round-trips controlled history, ignores malformed metadata, and keeps the newest 50", () => {
    let history = [];
    for (let index = 0; index < MAX_SPEND_ENTRIES + 2; index++) {
      history = appendSpendEntry(
        history,
        completedSpendEntry(`sha-${index}`, index % 2 === 0 ? "succeeded" : "failed", {
          inputTokens: index,
          outputTokens: index + 1,
        }),
      );
    }
    const rendered = renderSpendHistory(history);
    const parsed = parseSpendHistory(rendered);
    expect(rendered).toContain('<!-- janitor:spend:v1\n{"entries":');
    expect(rendered).not.toMatch(/-->\r?\n\{"entries":/u);
    expect(parsed).toHaveLength(50);
    expect(parsed[0]?.headSha).toBe("sha-2");
    expect(parsed.at(-1)?.headSha).toBe("sha-51");
    expect(rendered.indexOf("sha-2")).toBeLessThan(rendered.indexOf("sha-51"));
    expect(
      parseSpendHistory("<!-- janitor:spend:v1 -->\nnot json\n<!-- /janitor:spend:v1 -->"),
    ).toEqual([]);
  });

  it("migrates already-published metadata whose JSON was left visible", () => {
    const entry = completedSpendEntry("legacy-head", "succeeded", {
      inputTokens: 12,
      outputTokens: 4,
    });
    const legacy = `<!-- janitor:spend:v1 -->\n${JSON.stringify({ entries: [entry] })}\n<!-- /janitor:spend:v1 -->`;
    const parsed = parseSpendHistory(legacy);

    expect(parsed).toEqual([entry]);
    const repaired = renderSpendHistory(parsed);
    expect(repaired).not.toContain("<!-- janitor:spend:v1 -->");
    expect(repaired).not.toMatch(/-->\r?\n\{"entries":/u);
  });

  it("drops additional oldest entries until a complete comment fits", () => {
    const history = Array.from({ length: 50 }, (_, index) =>
      completedSpendEntry(`commit-${index}`, "succeeded", {
        inputTokens: index,
        outputTokens: index,
      }),
    );
    const fullLength = `review${renderSpendHistory(history)}`.length;
    const result = trimSpendHistoryToFit(
      history,
      (retained) => `review${renderSpendHistory(retained)}`,
      fullLength - 500,
    );
    expect(result.body.length).toBeLessThanOrEqual(fullLength - 500);
    expect(result.history.length).toBeLessThan(50);
    expect(result.history.at(-1)?.headSha).toBe("commit-49");
  });
});

describe("review reconciliation", () => {
  it("does not collect or render spend when tracking is disabled", async () => {
    const github = githubBoundary();
    const reviewAgent: ReviewAgentBoundary = {
      run: vi.fn(async (_input, reporter) => {
        expect(reporter).toBeUndefined();
        return { findings: [], dispositions: [], general: cleanGeneral };
      }),
    };
    await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: reviewAgent,
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
    });
    expect(github.updateGeneralComment.mock.calls.at(-1)?.[1]).not.toContain("### Spend");
  });

  it("removes an old spend ledger when tracking is disabled", async () => {
    const oldBody = renderGeneralCommentStatus("running", [
      completedSpendEntry("old-head", "succeeded", { inputTokens: 10, outputTokens: 4 }),
    ]);
    const github = githubBoundary({ general: true, generalBody: oldBody });
    await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: agent({ findings: [], dispositions: [], general: cleanGeneral }),
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
    });
    expect(github.updateGeneralComment).toHaveBeenNthCalledWith(
      1,
      9,
      expect.not.stringContaining("### Spend"),
    );
    expect(github.updateGeneralComment.mock.calls.at(-1)?.[1]).not.toContain("### Spend");
  });

  it("preserves history while running and appends distinct successful reruns", async () => {
    const prior = completedSpendEntry("head-sha", "succeeded", {
      inputTokens: 10,
      outputTokens: 4,
      estimatedCostUsd: 0.01,
    });
    const github = githubBoundary({
      general: true,
      generalBody: renderGeneralCommentStatus("running", [prior]),
    });
    const reviewAgent: ReviewAgentBoundary = {
      run: vi.fn(async (_input, reporter) => {
        expect(github.updateGeneralComment.mock.calls[0]?.[1]).toContain("### Spend");
        reporter?.({ inputTokens: 20, outputTokens: 8, estimatedCostUsd: 0.02 });
        reporter?.({ inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0.005 });
        return { findings: [], dispositions: [], general: cleanGeneral };
      }),
    };
    await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: reviewAgent,
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: true }),
    });
    const history = parseSpendHistory(String(github.updateGeneralComment.mock.calls.at(-1)?.[1]));
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.headSha)).toEqual(["head-sha", "head-sha"]);
    expect(history[1]).toMatchObject({
      status: "succeeded",
      inputTokens: 25,
      outputTokens: 10,
      estimatedCostUsd: 0.025,
    });
  });

  it("records partial usage for a failed agent run", async () => {
    const github = githubBoundary();
    const failure = new Error("agent failed after a response");
    await expect(
      executeReview({
        cwd: "/repo",
        context,
        git: reviewGit(),
        github,
        agent: {
          run: vi.fn(async (_input, reporter) => {
            reporter?.({ inputTokens: 12, outputTokens: 3, estimatedCostUsd: 0.004 });
            throw failure;
          }),
        },
        configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: true }),
      }),
    ).rejects.toBe(failure);
    const failedBody = String(github.updateGeneralComment.mock.calls.at(-1)?.[1]);
    expect(parseSpendHistory(failedBody)).toEqual([
      expect.objectContaining({
        status: "failed",
        inputTokens: 12,
        outputTokens: 3,
        estimatedCostUsd: 0.004,
      }),
    ]);
  });

  it("records zero tokens and unavailable cost when a failed attempt reports no usage", async () => {
    const github = githubBoundary();
    await expect(
      executeReview({
        cwd: "/repo",
        context,
        git: reviewGit(),
        github,
        agent: { run: vi.fn(async () => Promise.reject(new Error("unavailable"))) },
        configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: true }),
      }),
    ).rejects.toThrow("unavailable");
    const entry = parseSpendHistory(String(github.updateGeneralComment.mock.calls.at(-1)?.[1]))[0];
    expect(entry).toMatchObject({ status: "failed", inputTokens: 0, outputTokens: 0 });
    expect(entry?.estimatedCostUsd).toBeUndefined();
    expect(github.updateGeneralComment.mock.calls.at(-1)?.[1]).toContain("| — |");
  });

  it("creates the canonical progress comment before the agent starts and updates it in place", async () => {
    const github = githubBoundary();
    const reviewAgent: ReviewAgentBoundary = {
      run: vi.fn(async () => {
        expect(github.createGeneralComment).toHaveBeenCalledWith(
          expect.stringContaining(GENERAL_REVIEW_MARKER),
        );
        expect(github.createGeneralComment).toHaveBeenCalledWith(
          expect.stringContaining("Review in progress"),
        );
        return { findings: [], dispositions: [], general: cleanGeneral };
      }),
    };

    await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: reviewAgent,
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
    });

    expect(github.createGeneralComment).toHaveBeenCalledOnce();
    expect(github.updateGeneralComment).toHaveBeenCalledWith(
      10,
      expect.stringContaining("Confidence: 4/5"),
    );
  });

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
    expect(github.createGeneralComment).toHaveBeenCalledWith(
      expect.stringContaining("Review in progress"),
    );
    expect(github.updateGeneralComment).toHaveBeenCalledWith(
      10,
      expect.stringContaining("Confidence: 4/5"),
    );
    expect(github.updateGeneralComment).toHaveBeenLastCalledWith(
      10,
      expect.stringContaining("**Incorrect replacement** [►](https://github.com/c/1)"),
    );
    expect(github.getPullRequestBody).toHaveBeenCalledTimes(2);
    expect(github.updatePullRequestBody).toHaveBeenCalledTimes(2);
    expect(github.updatePullRequestBody.mock.calls[0]?.[0]).toContain(
      "👀 Janitor review in progress",
    );
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("✅ Janitor review complete");
  });

  it("folds findings outside the diff into the general comment instead of failing", async () => {
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
          {
            title: "Unchanged caller breaks",
            body: "The caller still passes the old argument.",
            severity: "medium",
            path: "src/a.ts",
            side: "RIGHT",
            line: 99,
          },
          {
            title: "Untouched file depends on old shape",
            body: "This file was not changed but relies on the removed field.",
            severity: "low",
            path: "src/untouched.ts",
            side: "RIGHT",
            line: 4,
          },
        ],
        dispositions: [],
        general: cleanGeneral,
      },
      github,
    );

    expect(result).toEqual({ skipped: false, newFindings: 3, stillOpen: 0, fixed: 0 });
    expect(github.createInlineComment).toHaveBeenCalledOnce();
    expect(github.createInlineComment.mock.calls[0]?.[0]).toMatchObject({ line: 2 });
    const generalBody = github.updateGeneralComment.mock.calls.at(-1)?.[1] as string;
    expect(generalBody).toContain("### Findings outside the diff");
    expect(generalBody).toContain(
      "**MEDIUM: Unchanged caller breaks**\n`src/a.ts` line 99 (RIGHT)",
    );
    expect(generalBody).toContain("The caller still passes the old argument.");
    expect(generalBody).toContain(
      "**LOW: Untouched file depends on old shape**\n`src/untouched.ts` line 4 (RIGHT)",
    );
    expect(generalBody).toContain(
      "1. ![high](https://img.shields.io/badge/high-orange) **Incorrect replacement** [►](https://github.com/c/1)",
    );
    expect(generalBody).toContain(
      "2. ![medium](https://img.shields.io/badge/medium-yellow) **Unchanged caller breaks**\n",
    );
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("✅ Janitor review complete");
  });

  it("folds a finding into the general comment when GitHub rejects its inline location", async () => {
    const github = githubBoundary();
    github.createInlineComment.mockRejectedValueOnce(
      Object.assign(new Error("Line could not be resolved"), { status: 422 }),
    );
    const messages: string[] = [];
    const finding = {
      title: "Incorrect replacement",
      body: "This changes the behavior unexpectedly.",
      severity: "high" as const,
      path: "src/a.ts",
      side: "RIGHT" as const,
      line: 2,
    };

    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: agent({
        findings: [finding, { ...finding, title: "Second issue", side: "LEFT" }],
        dispositions: [],
        general: cleanGeneral,
      }),
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
      report: (message) => messages.push(message),
    });

    expect(result).toEqual({ skipped: false, newFindings: 2, stillOpen: 0, fixed: 0 });
    expect(github.createInlineComment).toHaveBeenCalledTimes(2);
    const generalBody = github.updateGeneralComment.mock.calls.at(-1)?.[1] as string;
    expect(generalBody).toContain("**HIGH: Incorrect replacement**\n`src/a.ts` line 2 (RIGHT)");
    expect(generalBody).toContain("**Incorrect replacement**\n");
    expect(generalBody).toContain("**Second issue** [►](https://github.com/c/1)");
    expect(messages).toContain(
      "GitHub rejected the inline location src/a.ts:2 (RIGHT): Line could not be resolved; it will be included in the general comment.",
    );
  });

  it("still fails the review for inline comment errors other than an invalid location", async () => {
    const github = githubBoundary();
    github.createInlineComment.mockRejectedValueOnce(
      Object.assign(new Error("Bad credentials"), { status: 401 }),
    );

    await expect(
      execute(
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
      ),
    ).rejects.toThrow("Bad credentials");
    expect(github.updateGeneralComment).toHaveBeenLastCalledWith(
      10,
      expect.stringContaining("Review failed"),
    );
  });

  it("lists outside-diff findings compactly when their full bodies would not fit", async () => {
    const github = githubBoundary();
    const largeFinding = (line: number) => ({
      title: `Large issue ${line}`,
      body: "x".repeat(40_000),
      severity: "medium" as const,
      path: "src/other.ts",
      side: "RIGHT" as const,
      line,
    });

    await execute(
      { findings: [largeFinding(1), largeFinding(2)], dispositions: [], general: cleanGeneral },
      github,
    );

    const generalBody = github.updateGeneralComment.mock.calls.at(-1)?.[1] as string;
    expect(generalBody.length).toBeLessThanOrEqual(65_536);
    expect(generalBody).toContain("- **MEDIUM: Large issue 1** — `src/other.ts` line 1 (RIGHT)");
    expect(generalBody).toContain("- **MEDIUM: Large issue 2** — `src/other.ts` line 2 (RIGHT)");
    expect(generalBody).not.toContain("xxxx");
  });

  it("keeps a published review when 422 fallbacks would overflow the compact list", async () => {
    const github = githubBoundary();
    github.createInlineComment.mockRejectedValue(
      Object.assign(new Error("Line could not be resolved"), { status: 422 }),
    );
    const messages: string[] = [];
    const findings = [1, 2].map((index) => ({
      title: `${"t".repeat(40_000)} ${index}`,
      body: "Impact",
      severity: "low" as const,
      path: "src/a.ts",
      side: "RIGHT" as const,
      line: 2,
    }));

    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: agent({ findings, dispositions: [], general: cleanGeneral }),
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
      report: (message) => messages.push(message),
    });

    expect(result).toEqual({ skipped: false, newFindings: 2, stillOpen: 0, fixed: 0 });
    const generalBody = github.updateGeneralComment.mock.calls.at(-1)?.[1] as string;
    expect(generalBody.length).toBeLessThanOrEqual(65_536);
    expect(generalBody).toContain("The details of 2 finding(s) were too large to include here");
    expect(generalBody).toContain("Confidence: 4/5");
    expect(
      messages.filter((message) => message.startsWith("Finding outside the diff omitted")),
    ).toHaveLength(2);
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("✅ Janitor review complete");
  });

  it("rejects near-limit general content before publishing when fallbacks could overflow", async () => {
    const github = githubBoundary();
    const baseLength = renderGeneralComment(
      cleanGeneral,
      [{ title: "Incorrect replacement", severity: "high" }],
      { stillOpen: 0, fixed: 0 },
    ).length;
    const general = {
      ...cleanGeneral,
      summary: cleanGeneral.summary + "s".repeat(65_536 - baseLength - 10),
    };

    await expect(
      execute(
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
          general,
        },
        github,
      ),
    ).rejects.toThrow(/comment size limit/u);
    expect(github.createInlineComment).not.toHaveBeenCalled();
  });

  it("continues the review when the running status cannot be published", async () => {
    const github = githubBoundary();
    github.getPullRequestBody.mockRejectedValueOnce(new Error("status unavailable"));
    const reviewAgent = agent({ findings: [], dispositions: [], general: cleanGeneral });
    const messages: string[] = [];

    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: reviewAgent,
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
      report: (message) => messages.push(message),
    });

    expect(result).toEqual({ skipped: false, newFindings: 0, stillOpen: 0, fixed: 0 });
    expect(reviewAgent.run).toHaveBeenCalledOnce();
    expect(github.createGeneralComment).toHaveBeenCalledOnce();
    expect(github.updatePullRequestBody).toHaveBeenCalledOnce();
    expect(messages).toContain("Unable to publish pull request running status: status unavailable");
  });

  it("uses the maximum-confidence completion status for a 5/5 review", async () => {
    const github = githubBoundary({ body: "Author content" });
    await execute(
      {
        findings: [],
        dispositions: [],
        general: { ...cleanGeneral, confidence: 5 },
      },
      github,
    );

    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain(
      "👍 Janitor review complete — confidence 5/5",
    );
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("Author content");
  });

  it("keeps a published review successful when the completion status fails", async () => {
    const github = githubBoundary({ body: "Author content" });
    const runningBody = reconcileReviewDescription("Author content", context.headSha, "running");
    github.getPullRequestBody
      .mockResolvedValueOnce("Author content")
      .mockResolvedValueOnce(runningBody);
    github.updatePullRequestBody
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("status unavailable"));
    const messages: string[] = [];

    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: agent({
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
      }),
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
      report: (message) => messages.push(message),
    });

    expect(result).toEqual({ skipped: false, newFindings: 1, stillOpen: 0, fixed: 0 });
    expect(github.createInlineComment).toHaveBeenCalledOnce();
    expect(github.createGeneralComment).toHaveBeenCalledOnce();
    expect(github.getPullRequestBody).toHaveBeenCalledTimes(2);
    expect(github.updatePullRequestBody).toHaveBeenCalledTimes(2);
    expect(messages).toContain(
      "Unable to publish pull request complete status: status unavailable",
    );
    expect(messages).not.toContain("Pull request status set to failed.");
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
    expect(github.updateGeneralComment).toHaveBeenNthCalledWith(
      1,
      9,
      expect.stringContaining("Review in progress"),
    );
    expect(github.updateGeneralComment).toHaveBeenNthCalledWith(
      2,
      9,
      expect.stringContaining("Confidence: 4/5"),
    );
    expect(github.createGeneralComment).not.toHaveBeenCalled();
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
    expect(github.updateGeneralComment).toHaveBeenCalledTimes(2);
  });

  it("leaves a fixed thread open when GitHub refuses to resolve it", async () => {
    const github = githubBoundary({ previous: true, general: true });
    github.resolveThread.mockRejectedValueOnce(new Error("Resource not accessible by integration"));
    const messages: string[] = [];

    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github,
      agent: agent({
        findings: [],
        dispositions: [
          { threadId: "thread-1", status: "fixed", reason: "The unsafe branch was removed." },
        ],
        general: cleanGeneral,
      }),
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
      report: (message) => messages.push(message),
    });

    expect(result).toEqual({ skipped: false, newFindings: 0, stillOpen: 0, fixed: 1 });
    const generalBody = github.updateGeneralComment.mock.calls.at(-1)?.[1] as string;
    expect(generalBody).toContain("- Fixed findings resolved: 0");
    expect(generalBody).toContain("- Fixed findings that could not be resolved automatically: 1");
    expect(messages).toContain(
      "Unable to resolve fixed thread thread-1: Resource not accessible by integration; it was left open.",
    );
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("✅ Janitor review complete");
  });

  it("updates the early general comment when the review fails", async () => {
    const github = githubBoundary();
    const failure = new Error("agent unavailable");

    await expect(
      executeReview({
        cwd: "/repo",
        context,
        git: reviewGit(),
        github,
        agent: { run: vi.fn(async () => Promise.reject(failure)) },
        configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
      }),
    ).rejects.toThrow("agent unavailable");

    expect(github.createGeneralComment).toHaveBeenCalledWith(
      expect.stringContaining("Review in progress"),
    );
    expect(github.updateGeneralComment).toHaveBeenCalledWith(
      10,
      expect.stringContaining("Review failed"),
    );
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("❌ Janitor review failed");
  });

  it("does not publish inline or thread mutations for invalid model output", async () => {
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
    ).rejects.toThrow(/omitted dispositions/u);
    expect(github.createInlineComment).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
    expect(github.createGeneralComment).toHaveBeenCalledWith(
      expect.stringContaining("Review in progress"),
    );
    expect(github.updateGeneralComment).toHaveBeenCalledWith(
      10,
      expect.stringContaining("Review failed"),
    );
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("❌ Janitor review failed");
  });

  it("rejects reserved markers before any review comment or thread mutation", async () => {
    const github = githubBoundary({ previous: true, general: true });
    await expect(
      execute(
        {
          findings: [
            {
              title: "Marker parsing is too broad",
              body: `The parser accepts ${FINDING_MARKER} in review text.`,
              severity: "high",
              path: "src/a.ts",
              side: "RIGHT",
              line: 2,
            },
          ],
          dispositions: [
            { threadId: "thread-1", status: "fixed", reason: "The old issue was removed." },
          ],
          general: cleanGeneral,
        },
        github,
      ),
    ).rejects.toThrow(/finding body contains a reserved Janitor marker/u);
    expect(github.createInlineComment).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
    expect(github.createGeneralComment).not.toHaveBeenCalled();
    expect(github.updateGeneralComment).toHaveBeenNthCalledWith(
      1,
      9,
      expect.stringContaining("Review in progress"),
    );
    expect(github.updateGeneralComment).toHaveBeenNthCalledWith(
      2,
      9,
      expect.stringContaining("Review failed"),
    );
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain("❌ Janitor review failed");
  });

  it("skips before GitHub feedback or model access when tracked paths do not match", async () => {
    const github = githubBoundary();
    const reviewAgent = agent({ findings: [], dispositions: [], general: cleanGeneral });
    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit("docs/a.md"),
      github,
      agent: reviewAgent,
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
    });
    expect(result.skipped).toBe(true);
    expect(github.listGeneralComments).not.toHaveBeenCalled();
    expect(reviewAgent.run).not.toHaveBeenCalled();
    expect(github.getPullRequestBody).toHaveBeenCalledTimes(2);
    expect(github.updatePullRequestBody.mock.calls[1]?.[0]).toContain(
      "⏭️ Janitor review skipped — no tracked paths changed",
    );
  });

  it("returns skipped when the skipped status cannot be published", async () => {
    const github = githubBoundary();
    github.updatePullRequestBody
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("status unavailable"));
    const reviewAgent = agent({ findings: [], dispositions: [], general: cleanGeneral });
    const messages: string[] = [];

    const result = await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit("docs/a.md"),
      github,
      agent: reviewAgent,
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: true }),
      report: (message) => messages.push(message),
    });

    expect(result).toEqual({ skipped: true, newFindings: 0, stillOpen: 0, fixed: 0 });
    expect(reviewAgent.run).not.toHaveBeenCalled();
    expect(github.updatePullRequestBody).toHaveBeenCalledTimes(2);
    expect(messages).toContain("Unable to publish pull request skipped status: status unavailable");
  });

  it("reports lifecycle progress in order", async () => {
    const messages: string[] = [];
    await executeReview({
      cwd: "/repo",
      context,
      git: reviewGit(),
      github: githubBoundary(),
      agent: agent({ findings: [], dispositions: [], general: cleanGeneral }),
      configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
      report: (message) => messages.push(message),
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("collecting the pull request diff"),
        expect.stringContaining("Loading previous Janitor feedback"),
        expect.stringContaining("Starting the coding review agent"),
        expect.stringContaining("validating its output"),
        expect.stringContaining("Publishing validated review feedback"),
      ]),
    );
    expect(messages.indexOf("Starting the coding review agent.")).toBeLessThan(
      messages.indexOf("Coding review agent finished; validating its output."),
    );
    expect(messages.indexOf("Agent output validated successfully.")).toBeLessThan(
      messages.indexOf("Publishing validated review feedback to GitHub."),
    );
  });

  it("keeps the original review error when failed-status publication also fails", async () => {
    const github = githubBoundary();
    github.updatePullRequestBody
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("status update failed"));
    const original = new Error("agent failed");
    const failingAgent: ReviewAgentBoundary = { run: vi.fn(async () => Promise.reject(original)) };
    const messages: string[] = [];

    await expect(
      executeReview({
        cwd: "/repo",
        context,
        git: reviewGit(),
        github,
        agent: failingAgent,
        configLoader: async () => ({ trackedPaths: ["src/**"], trackSpend: false }),
        report: (message) => messages.push(message),
      }),
    ).rejects.toBe(original);
    expect(messages).toContain(
      "Unable to publish pull request failed status: status update failed",
    );
  });

  it("does not replace a newer head's running status with a stale completion", async () => {
    const github = githubBoundary({ body: "Author content" });
    github.getPullRequestBody
      .mockResolvedValueOnce("Author content")
      .mockResolvedValueOnce(reconcileReviewDescription("Author content", "newer-head", "running"));

    await execute({ findings: [], dispositions: [], general: cleanGeneral }, github);

    expect(github.updatePullRequestBody).toHaveBeenCalledTimes(1);
    expect(github.updatePullRequestBody.mock.calls[0]?.[0]).toContain(
      "👀 Janitor review in progress",
    );
  });
});

describe("safe agent progress", () => {
  it("reports tool lifecycle without including arguments or results", () => {
    const started = formatAgentActivity({
      type: "tool_execution_start",
      toolCallId: "call",
      toolName: "read",
      args: { path: "secret-file.ts", content: "do not log" },
    } as never);
    const failed = formatAgentActivity({
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "grep",
      result: { content: "do not log" },
      isError: true,
    } as never);

    expect(started).toBe("Agent started reading a repository file.");
    expect(started).not.toContain("secret-file.ts");
    expect(failed).toBe("Agent failed while searching repository text.");
    expect(failed).not.toContain("do not log");
  });

  it("reports retries and compaction without provider error contents", () => {
    const retry = formatAgentActivity({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: "credential-shaped provider detail",
    } as never);
    const compacted = formatAgentActivity({
      type: "compaction_end",
      reason: "threshold",
      result: {},
      aborted: false,
      willRetry: false,
      errorMessage: "private context detail",
    } as never);

    expect(retry).toBe("Agent request retry 1/3 scheduled in 500ms.");
    expect(retry).not.toContain("credential-shaped");
    expect(compacted).toBe("Agent context compaction finished.");
    expect(formatAgentActivity({ type: "message_update" } as never)).toBeUndefined();
  });
});
