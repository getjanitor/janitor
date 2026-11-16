import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import { buildReviewPrompt } from "#/review/agent";
import type { ReviewConfig } from "#/review/config";
import { errorMessage, GitError } from "#/review/errors";
import { collectIncrementalReview, collectReviewDiff } from "#/review/git";
import { gitHubReviewFromClient } from "#/review/github";
import { FINDING_MARKER, GENERAL_REVIEW_MARKER } from "#/review/markers";
import { executeReview } from "#/review/orchestrator";
import { parseReviewedState, renderReviewedState } from "#/review/reviewed_state";
import {
  GitCommand,
  GitHubReview,
  PullRequest,
  ReviewAgent,
  ReviewConfigLoader,
  ReviewReporter,
} from "#/review/services";
import type {
  GitCommandBoundary,
  ModelReviewResult,
  PullRequestContext,
  ReviewAgentInput,
  ReviewedState,
  ReviewThreadRecord,
} from "#/review/types";

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

const general = {
  summary: "The change is focused.",
  mermaid: "flowchart LR\n  A[Caller] --> B[Changed code]",
  confidence: 4,
  confidenceReason: "All changed files were inspected.",
};

const PATHS = ["src/a.ts", "src/b.ts"];

function prPatch(path: string, unified: number): string {
  return unified === 0
    ? `diff --git a/${path} b/${path}\n@@ -2 +2,2 @@\n-old\n+new\n+added\n`
    : `diff --git a/${path} b/${path}\n@@ -1,3 +1,4 @@\n before\n-old\n+new\n+added\n after\n`;
}

/**
 * A pull request changing two files at lines 2–3. Since `prev-sha`, only the paths in
 * `changedSince` changed, at line 3 plus line 9, which is not part of the PR diff.
 */
function twoFileGit(options: { ancestor?: boolean; changedSince?: string[] } = {}) {
  const calls: string[][] = [];
  const git: GitCommandBoundary = {
    run: (args) =>
      Effect.tryPromise({
        try: async () => {
          calls.push(args);
          if (args[0] === "rev-parse") return "head-sha\n";
          if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
            if (options.ancestor === false) throw new Error("exit code 1");
            return "";
          }
          if (args[0] === "merge-base") return "merge-sha\n";
          if (args.includes("--name-status")) return PATHS.map((path) => `M\0${path}\0`).join("");
          const path = args.at(-1) ?? "";
          const unified = args.includes("--unified=0") ? 0 : 20;
          if (args.includes("merge-sha")) return prPatch(path, unified);
          if (args.includes("prev-sha")) {
            if (!(options.changedSince ?? ["src/a.ts"]).includes(path)) return "";
            return `diff --git a/${path} b/${path}\n@@ -3 +3 @@\n-first\n+added\n@@ -9 +9 @@\n-x\n+merged-from-main\n`;
          }
          throw new Error(`Unexpected git args: ${args.join(" ")}`);
        },
        catch: (cause) => new GitError({ message: errorMessage(cause), args, cause }),
      }),
  };
  return { git, calls };
}

function thread(id: string, path: string, replies: string[] = []): ReviewThreadRecord {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path,
    line: 2,
    originalLine: 2,
    comments: [
      { databaseId: 1, body: `${FINDING_MARKER}\n**HIGH: Issue in ${path}**`, author: "app[bot]" },
      ...replies.map((body) => ({ databaseId: 2, body, author: "dev" })),
    ],
  };
}

function github(options: { reviewed?: ReviewedState; threads?: ReviewThreadRecord[] } = {}) {
  return {
    listGeneralComments: vi.fn(async () => [
      {
        id: 9,
        body: `${GENERAL_REVIEW_MARKER}\n## Janitor review\n${renderReviewedState(options.reviewed)}`,
        author: "app[bot]",
      },
    ]),
    listReviewThreads: vi.fn(async () => options.threads ?? []),
    createInlineComment: vi.fn(async () => "https://github.com/c/1"),
    resolveThread: vi.fn(async () => undefined),
    createGeneralComment: vi.fn(async () => 10),
    updateGeneralComment: vi.fn(async (_id: number, _body: string) => undefined),
  };
}

function run(options: {
  git: GitCommandBoundary;
  github: ReturnType<typeof github>;
  result?: (input: ReviewAgentInput) => ModelReviewResult;
  config?: Partial<ReviewConfig>;
  details?: string[];
}) {
  const inputs: ReviewAgentInput[] = [];
  const layers = Layer.mergeAll(
    Layer.succeed(PullRequest)(context),
    Layer.succeed(GitCommand)(options.git),
    Layer.succeed(GitHubReview)(gitHubReviewFromClient(options.github)),
    Layer.succeed(ReviewAgent)({
      run: (input) =>
        Effect.sync(() => {
          inputs.push(input);
          return (
            options.result?.(input) ?? {
              findings: [],
              dispositions: input.previousFindings.map((finding) => ({
                threadId: finding.threadId,
                status: "still_present" as const,
              })),
              general,
            }
          );
        }),
    }),
    Layer.succeed(ReviewConfigLoader)({
      load: () => Effect.succeed({ trackedPaths: ["**"], trackSpend: false, ...options.config }),
    }),
    Layer.succeed(ReviewReporter)({
      step: () => Effect.void,
      detail: (message) => Effect.sync(() => options.details?.push(message)),
    }),
  );
  return Effect.runPromise(executeReview({ cwd: "/repo" }).pipe(Effect.provide(layers))).then(
    (result) => ({ result, inputs }),
  );
}

function lastBody(client: ReturnType<typeof github>): string {
  return String(client.updateGeneralComment.mock.calls.at(-1)?.[1]);
}

describe("reviewed state marker", () => {
  it("round-trips through a comment even when model text could close an HTML comment", () => {
    const state = { headSha: "abc123", summary: "Ends --> early <!-- x", mermaid: "graph A-->B" };
    const rendered = renderReviewedState(state);
    expect(rendered.match(/-->/gu)).toHaveLength(1);
    expect(parseReviewedState(`before${rendered}after`)).toEqual(state);
  });

  it("ignores missing, malformed, and option-like states", () => {
    expect(parseReviewedState("no marker")).toBeUndefined();
    expect(parseReviewedState("<!-- janitor:reviewed:v1\n{nope\n-->")).toBeUndefined();
    expect(parseReviewedState(renderReviewedState({ headSha: "--output=x" }))).toBeUndefined();
  });
});

describe("incremental scope collection", () => {
  it("keeps only PR files that changed, and only lines that are part of the PR diff", async () => {
    const { git } = twoFileGit();
    const diff = await Effect.runPromise(collectReviewDiff("/repo", context, git));
    const scope = await Effect.runPromise(
      collectIncrementalReview("/repo", diff, { headSha: "prev-sha" }, git),
    );
    expect("fallback" in scope).toBe(false);
    if ("fallback" in scope) return;
    expect(scope.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    // Line 9 changed since the last review (e.g. a base-branch merge) but is not in the PR diff.
    expect([...(scope.files[0]?.rightLines ?? [])]).toEqual([3]);
  });

  it("falls back to a full review when the last reviewed commit is not an ancestor", async () => {
    const { git } = twoFileGit({ ancestor: false });
    const diff = await Effect.runPromise(collectReviewDiff("/repo", context, git));
    const scope = await Effect.runPromise(
      collectIncrementalReview("/repo", diff, { headSha: "prev-sha" }, git),
    );
    expect(scope).toMatchObject({ fallback: expect.stringContaining("not an ancestor") });
  });
});

describe("incremental re-reviews", () => {
  it("records the reviewed head after a full review and keeps it while running", async () => {
    const client = github();
    const { result } = await run({ git: twoFileGit().git, github: client });
    expect(result.incrementalFrom).toBeUndefined();
    expect(parseReviewedState(lastBody(client))).toEqual({
      headSha: "head-sha",
      summary: general.summary,
      mermaid: general.mermaid,
    });

    const rerun = github({ reviewed: { headSha: "prev-sha" } });
    await run({ git: twoFileGit().git, github: rerun });
    const runningBody = String(rerun.updateGeneralComment.mock.calls[0]?.[1]);
    expect(runningBody).toContain("Review in progress");
    expect(parseReviewedState(runningBody)?.headSha).toBe("prev-sha");
  });

  it("keeps the last reviewed head when a re-review fails", async () => {
    const client = github({ reviewed: { headSha: "prev-sha" } });
    await expect(
      run({
        git: twoFileGit().git,
        github: client,
        result: () => ({ findings: [], dispositions: [], general: undefined }),
      }),
    ).rejects.toThrow();
    expect(lastBody(client)).toContain("Review failed");
    expect(parseReviewedState(lastBody(client))?.headSha).toBe("prev-sha");
  });

  it("skips without touching GitHub when head was already reviewed", async () => {
    const client = github({ reviewed: { headSha: "head-sha" } });
    const { result, inputs } = await run({ git: twoFileGit().git, github: client });
    expect(result).toMatchObject({
      skipped: true,
      skipReason: expect.stringContaining("head-sha"),
    });
    expect(inputs).toHaveLength(0);
    expect(client.updateGeneralComment).not.toHaveBeenCalled();
  });

  it("reviews an already reviewed head again when incremental reviews are disabled", async () => {
    const client = github({ reviewed: { headSha: "head-sha" } });
    const { result, inputs } = await run({
      git: twoFileGit().git,
      github: client,
      config: { incremental: false },
    });
    expect(result.skipped).toBe(false);
    expect(inputs[0]?.incremental).toBeUndefined();
  });

  it("skips when no pull-request file changed since the last review", async () => {
    const client = github({ reviewed: { headSha: "prev-sha" } });
    const { result, inputs } = await run({
      git: twoFileGit({ changedSince: [] }).git,
      github: client,
    });
    expect(result).toMatchObject({ skipped: true });
    expect(inputs).toHaveLength(0);
  });

  it.each([
    ["the head was already reviewed", "head-sha", ["src/a.ts"]],
    ["no pull-request file changed", "prev-sha", []],
  ])(
    "re-evaluates only disputed findings instead of skipping when %s",
    async (_case, reviewedSha, changedSince) => {
      const client = github({
        reviewed: { headSha: reviewedSha },
        threads: [thread("untouched", "src/a.ts"), thread("disputed", "src/b.ts", ["Intended."])],
      });
      const { result, inputs } = await run({
        git: twoFileGit({ changedSince }).git,
        github: client,
      });
      expect(result.skipped).toBe(false);
      expect(inputs[0]?.incremental?.files).toEqual([]);
      expect(inputs[0]?.previousFindings.map((finding) => finding.threadId)).toEqual(["disputed"]);
      expect(result).toMatchObject({ stillOpen: 2, newFindings: 0 });
      expect(buildReviewPrompt(inputs[0] as ReviewAgentInput)).toContain(
        "do not report new findings",
      );
    },
  );

  it("re-reviews only changed files and keeps unaffected findings open itself", async () => {
    const client = github({
      reviewed: { headSha: "prev-sha", summary: "Old summary", mermaid: "graph A-->B" },
      threads: [
        thread("in-changed-file", "src/a.ts"),
        thread("untouched", "src/b.ts"),
        thread("disputed", "src/b.ts", ["This is intended."]),
      ],
    });
    const { result, inputs } = await run({
      git: twoFileGit().git,
      github: client,
      result: (input) => ({
        findings: [],
        dispositions: input.previousFindings.map((finding) => ({
          threadId: finding.threadId,
          status: "fixed" as const,
          reason: "Verified.",
        })),
        general,
      }),
    });
    const input = inputs[0];
    expect(input?.incremental?.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(input?.previousFindings.map((finding) => finding.threadId)).toEqual([
      "in-changed-file",
      "disputed",
    ]);
    expect(client.resolveThread.mock.calls.map(([id]) => id)).toEqual([
      "in-changed-file",
      "disputed",
    ]);
    expect(result).toMatchObject({ stillOpen: 1, fixed: 2, incrementalFrom: "prev-sha" });
    expect(parseReviewedState(lastBody(client))?.headSha).toBe("head-sha");

    const prompt = buildReviewPrompt(input as ReviewAgentInput);
    expect(prompt).toContain("incremental re-review");
    expect(prompt).toContain("prev-sha");
    expect(prompt).toContain("Old summary");
    expect(prompt).toContain("since_last_review=true");
  });

  it("drops findings outside the incremental scope that bypassed the tool", async () => {
    const details: string[] = [];
    const client = github({ reviewed: { headSha: "prev-sha" } });
    const finding = {
      title: "Issue",
      body: "Impact",
      severity: "high" as const,
      side: "RIGHT" as const,
    };
    const { result } = await run({
      git: twoFileGit().git,
      github: client,
      details,
      result: () => ({
        findings: [
          { ...finding, path: "src/a.ts", line: 3 },
          { ...finding, path: "src/a.ts", line: 2 },
          { ...finding, path: "src/b.ts", line: 3 },
        ],
        dispositions: [],
        general,
      }),
    });
    expect(result.newFindings).toBe(1);
    expect(client.createInlineComment).toHaveBeenCalledTimes(1);
    expect(details.filter((message) => message.startsWith("Dropping finding"))).toHaveLength(2);
  });

  it("falls back to a full review after a force-push", async () => {
    const client = github({
      reviewed: { headSha: "prev-sha" },
      threads: [thread("t", "src/b.ts")],
    });
    const { result, inputs } = await run({
      git: twoFileGit({ ancestor: false }).git,
      github: client,
    });
    expect(inputs[0]?.incremental).toBeUndefined();
    expect(inputs[0]?.previousFindings).toHaveLength(1);
    expect(result.incrementalFrom).toBeUndefined();
  });
});
