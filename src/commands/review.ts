import { cli, type CliOptions } from "cleye";
import { CodingReviewAgent } from "#/review/agent";
import { defaultGitCommand } from "#/review/git";
import { GitHubReviewClient } from "#/review/github";
import { executeReview, type ExecuteReviewResult } from "#/review/orchestrator";
import { readPullRequestContext, readReviewEnvironment } from "#/review/runtime";
import type {
  GitCommandBoundary,
  GitHubReviewBoundary,
  PullRequestContext,
  ReviewAgentBoundary,
  ReviewEnvironment,
} from "#/review/types";

export const reviewCliOptions = {
  help: {
    description: "Review the current GitHub pull request for quality and security issues",
  },
  flags: {
    verbose: {
      type: Boolean,
      description: "Show detailed review and agent progress logs",
    },
  },
  strictFlags: true,
} satisfies CliOptions;

export interface ReviewOptions {
  verbose?: boolean;
}

export interface ReviewDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  git?: GitCommandBoundary;
  readContext?: (eventPath: string, repository: string) => Promise<PullRequestContext>;
  createAgent?: (
    environment: ReviewEnvironment,
    report: (message: string) => void,
  ) => ReviewAgentBoundary;
  createGitHub?: (
    environment: ReviewEnvironment,
    context: PullRequestContext,
  ) => GitHubReviewBoundary;
  report?: (message: string) => void;
}

export async function review(
  options: ReviewOptions = {},
  dependencies: ReviewDependencies = {},
): Promise<ExecuteReviewResult> {
  const report = dependencies.report ?? console.log;
  const environmentInput = dependencies.environment ?? process.env;
  const verbose = options.verbose === true || environmentInput.JANITOR_VERBOSE === "1";
  const progress = verbose ? report : () => undefined;
  const environment = readReviewEnvironment(environmentInput);
  const context = await (dependencies.readContext ?? readPullRequestContext)(
    environment.githubEventPath,
    environment.githubRepository,
  );
  const result = await executeReview({
    cwd: dependencies.cwd ?? process.cwd(),
    context,
    git: dependencies.git ?? defaultGitCommand,
    agent: (
      dependencies.createAgent ?? ((input, progress) => new CodingReviewAgent(input, progress))
    )(environment, progress),
    github: (
      dependencies.createGitHub ??
      ((input, pullRequest) =>
        new GitHubReviewClient({
          token: input.githubToken,
          apiUrl: input.githubApiUrl,
          graphqlUrl: input.githubGraphqlUrl,
          context: pullRequest,
        }))
    )(environment, context),
    report: progress,
  });

  report(
    result.skipped
      ? `Janitor review skipped: ${result.skipReason ?? "no review was needed."}`
      : `Janitor review complete: ${result.newFindings} new, ${result.stillOpen} still open, ${result.fixed} fixed.`,
  );
  return result;
}

export type ReviewAction = (options: ReviewOptions) => unknown | Promise<unknown>;

export function runReviewCommand(action: ReviewAction = review, argv?: string[]) {
  return cli(reviewCliOptions, ({ flags }) => action({ verbose: flags.verbose ?? false }), argv);
}

export default function reviewCommand() {
  return runReviewCommand();
}
