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
  strictFlags: true,
} satisfies CliOptions;

export interface ReviewDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  git?: GitCommandBoundary;
  readContext?: (eventPath: string, repository: string) => Promise<PullRequestContext>;
  createAgent?: (environment: ReviewEnvironment) => ReviewAgentBoundary;
  createGitHub?: (
    environment: ReviewEnvironment,
    context: PullRequestContext,
  ) => GitHubReviewBoundary;
  report?: (message: string) => void;
}

export async function review(dependencies: ReviewDependencies = {}): Promise<ExecuteReviewResult> {
  const environment = readReviewEnvironment(dependencies.environment);
  const context = await (dependencies.readContext ?? readPullRequestContext)(
    environment.githubEventPath,
    environment.githubRepository,
  );
  const result = await executeReview({
    cwd: dependencies.cwd ?? process.cwd(),
    context,
    git: dependencies.git ?? defaultGitCommand,
    agent: (dependencies.createAgent ?? ((input) => new CodingReviewAgent(input)))(environment),
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
  });

  const report = dependencies.report ?? console.log;
  report(
    result.skipped
      ? "Janitor review skipped: no changed path matched review.tracked_paths."
      : `Janitor review complete: ${result.newFindings} new, ${result.stillOpen} still open, ${result.fixed} fixed.`,
  );
  return result;
}

export type ReviewAction = () => unknown | Promise<unknown>;

export function runReviewCommand(action: ReviewAction = review, argv?: string[]) {
  return cli(reviewCliOptions, () => action(), argv);
}

export default function reviewCommand() {
  return runReviewCommand();
}
