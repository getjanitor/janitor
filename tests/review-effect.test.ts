import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { review } from "#/commands/review";
import {
  CommentTooLarge,
  GitError,
  GitHubError,
  ModelOutputInvalid,
  type ReviewError,
} from "#/review/errors";
import { formatReviewFailure } from "#/review/failure";
import { gitHubReviewFromClient } from "#/review/github";
import { GENERAL_REVIEW_MARKER } from "#/review/markers";
import { executeReview } from "#/review/orchestrator";
import { readReviewEnvironment } from "#/review/runtime";
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
  GitHubReviewClientShape,
  ModelReviewResult,
  NewFinding,
  PullRequestContext,
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

const cleanGeneral = {
  summary: "The change is focused and no actionable issues were found.",
  mermaid: "flowchart LR\n  A[Caller] --> B[Changed code]",
  confidence: 4,
  confidenceReason: "All changed files and their direct callers were inspected.",
};

const finding: NewFinding = {
  title: "Incorrect replacement",
  body: "This changes the behavior unexpectedly.",
  severity: "high",
  path: "src/a.ts",
  side: "RIGHT",
  line: 2,
};

const environment = {
  GITHUB_TOKEN: "ghp_secret-token",
  GITHUB_EVENT_PATH: "/unused-event.json",
  GITHUB_REPOSITORY: "owner/repo",
  JANITOR_PROVIDER: "provider",
  JANITOR_PROVIDER_KEY: "sk-secret-key",
  JANITOR_MODEL: "model",
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const git: GitCommandBoundary = {
  run: (args) => {
    if (args[0] === "rev-parse") return Effect.succeed("head-sha\n");
    if (args[0] === "merge-base") return Effect.succeed("merge-sha\n");
    if (args.includes("--name-status")) return Effect.succeed("M\0src/a.ts\0");
    return Effect.succeed(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-old\n+new\n",
    );
  },
};

function githubClient(): GitHubReviewClientShape {
  return {
    listGeneralComments: vi.fn(async () => []),
    listReviewThreads: vi.fn(async () => []),
    createInlineComment: vi.fn(async (): Promise<string | undefined> => "https://github.com/c/1"),
    resolveThread: vi.fn(async () => undefined),
    createGeneralComment: vi.fn(async () => 10),
    updateGeneralComment: vi.fn(async () => undefined),
  };
}

function layers(options: {
  git?: GitCommandBoundary;
  github?: GitHubReviewClientShape;
  result: ModelReviewResult;
  steps?: string[];
}) {
  return Layer.mergeAll(
    Layer.succeed(PullRequest)(context),
    Layer.succeed(GitCommand)(options.git ?? git),
    Layer.succeed(GitHubReview)(gitHubReviewFromClient(options.github ?? githubClient())),
    Layer.succeed(ReviewAgent)({ run: () => Effect.succeed(options.result) }),
    Layer.succeed(ReviewConfigLoader)({
      load: () => Effect.succeed({ trackedPaths: ["src/**"], trackSpend: false }),
    }),
    Layer.succeed(ReviewReporter)({
      step: (message) => Effect.sync(() => options.steps?.push(message)),
      detail: () => Effect.void,
    }),
  );
}

function reviewFailure(options: Parameters<typeof layers>[0]): Promise<ReviewError> {
  return Effect.runPromise(
    executeReview({ cwd: "/repo" }).pipe(Effect.flip, Effect.provide(layers(options))),
  );
}

describe("typed review failures", () => {
  it("fails with a GitError that keeps the command arguments and cause", async () => {
    const cause = new Error("fatal: not a git repository");
    const steps: string[] = [];
    const error = await reviewFailure({
      git: {
        run: (args) =>
          Effect.fail(new GitError({ message: `git ${args.join(" ")} failed`, args, cause })),
      },
      result: { findings: [], dispositions: [], general: cleanGeneral },
      steps,
    });

    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ _tag: "GitError", args: ["rev-parse", "HEAD"], cause });
    expect(steps.at(-1)).toBe(
      "Janitor review failed during context gathering: git rev-parse HEAD failed",
    );
  });

  it("tags GitHub failures with the operation and HTTP status", async () => {
    const github = githubClient();
    vi.mocked(github.createInlineComment).mockRejectedValueOnce(
      Object.assign(new Error("Bad credentials"), { status: 401 }),
    );
    const error = await reviewFailure({
      github,
      result: { findings: [finding], dispositions: [], general: cleanGeneral },
    });

    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({
      operation: "createInlineComment",
      status: 401,
      message: "Bad credentials",
    });
  });

  it("reports invalid model output as ModelOutputInvalid with its reason", async () => {
    const error = await reviewFailure({
      result: { findings: [], dispositions: [], general: undefined },
    });

    expect(error).toBeInstanceOf(ModelOutputInvalid);
    expect(error).toMatchObject({ reason: "Model review did not submit a general result" });
    expect(error.message).toBe("Model review did not submit a general result");
  });

  it("reports an oversized general comment as CommentTooLarge before posting inline", async () => {
    const github = githubClient();
    const error = await reviewFailure({
      github,
      result: {
        findings: [finding],
        dispositions: [],
        general: { ...cleanGeneral, summary: "s".repeat(65_536) },
      },
    });

    expect(error).toBeInstanceOf(CommentTooLarge);
    expect(github.createInlineComment).not.toHaveBeenCalled();
    expect(github.updateGeneralComment).toHaveBeenLastCalledWith(
      10,
      expect.stringContaining("Review failed"),
    );
  });
});

describe("review failure output", () => {
  it("names the error tag, its fields, the cause chain and the failing span", async () => {
    const exit = await Effect.runPromiseExit(
      executeReview({ cwd: "/repo" }).pipe(
        Effect.provide(
          layers({
            git: {
              run: (args) =>
                Effect.fail(
                  new GitError({
                    message: `git ${args.join(" ")} failed`,
                    args,
                    cause: new Error("Command failed: git rev-parse HEAD\nfatal: not a git repo"),
                  }),
                ),
            },
            result: { findings: [], dispositions: [], general: cleanGeneral },
          }),
        ),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected the review to fail");

    expect(formatReviewFailure(exit.cause)).toBe(
      [
        "Janitor review failed with GitError: git rev-parse HEAD failed",
        "  args: rev-parse HEAD",
        "  caused by: Error: Command failed: git rev-parse HEAD",
        "    fatal: not a git repo",
        "  span: janitor.review > janitor.review.collect_diff > janitor.git.collect_review_diff",
      ].join("\n"),
    );
  });

  it("prints the formatted failure and rejects with the tagged error", async () => {
    const reports: string[] = [];
    const errors: string[] = [];

    await expect(
      review(
        {},
        {
          environment: { ...environment, GITHUB_TOKEN: "" },
          report: (message) => reports.push(message),
          reportError: (message) => errors.push(message),
        },
      ),
    ).rejects.toMatchObject({ _tag: "ConfigError", source: "GITHUB_TOKEN" });
    expect(reports).toEqual([]);
    expect(errors).toEqual([
      [
        "Janitor review failed with ConfigError: Missing required environment variable GITHUB_TOKEN",
        "  source: GITHUB_TOKEN",
        "  span: janitor.config.environment",
      ].join("\n"),
    ]);
  });
});

describe("review environment", () => {
  it("keeps credentials redacted", () => {
    const parsed = readReviewEnvironment(environment);

    expect(Redacted.value(parsed.githubToken)).toBe("ghp_secret-token");
    expect(Redacted.value(parsed.providerKey)).toBe("sk-secret-key");
    const printed = `${String(parsed.githubToken)} ${JSON.stringify(parsed)}`;
    expect(printed).not.toContain("ghp_secret-token");
    expect(printed).not.toContain("sk-secret-key");
  });

  it("keeps an explicitly empty API URL, as before the Effect migration", () => {
    expect(readReviewEnvironment({ ...environment, GITHUB_API_URL: "" }).githubApiUrl).toBe("");
  });

  it("reads the pull-request event through the live layers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "janitor-review-effect-"));
    temporaryDirectories.push(directory);
    const eventPath = join(directory, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { full_name: "owner/repo" },
        pull_request: {
          number: 0,
          base: { ref: "main", sha: "base", repo: { full_name: "owner/repo" } },
          head: { ref: "feature", sha: "head", repo: { full_name: "owner/repo" } },
        },
      }),
    );
    const errors: string[] = [];

    await expect(
      review(
        {},
        {
          cwd: directory,
          environment: { ...environment, GITHUB_EVENT_PATH: eventPath },
          report: () => undefined,
          reportError: (message) => errors.push(message),
        },
      ),
    ).rejects.toMatchObject({ _tag: "EventError", path: eventPath });
    expect(errors[0]).toContain("Janitor review failed with EventError: Invalid GitHub");
    expect(errors[0]).toContain(`path: ${eventPath}`);
  });

  it("starts the general comment once the live stack is supplied with test services", async () => {
    const github = githubClient();
    const reports: string[] = [];
    await review(
      {},
      {
        environment,
        layers: {
          pullRequest: Layer.succeed(PullRequest)(context),
          git: Layer.succeed(GitCommand)(git),
          github: Layer.succeed(GitHubReview)(gitHubReviewFromClient(github)),
          agent: Layer.succeed(ReviewAgent)({
            run: () => Effect.succeed({ findings: [], dispositions: [], general: cleanGeneral }),
          }),
          config: Layer.succeed(ReviewConfigLoader)({
            load: () => Effect.succeed({ trackedPaths: ["src/**"], trackSpend: false }),
          }),
        },
        report: (message) => reports.push(message),
      },
    );

    expect(github.createGeneralComment).toHaveBeenCalledWith(
      expect.stringContaining(GENERAL_REVIEW_MARKER),
    );
    expect(reports.at(-1)).toBe(
      "Janitor review complete: 0 new, 0 still open, 0 fixed, 0 dismissed.",
    );
  });
});
