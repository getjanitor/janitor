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
    description: "Run configured code and security reviews for the current GitHub pull request",
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
  if (result.skipped) {
    report("Janitor review skipped: no review type had matched files or reviewable findings.");
  } else {
    for (const reviewType of ["code", "security"] as const) {
      const typeResult = result[reviewType];
      report(
        typeResult.skipped
          ? `Janitor ${reviewType} review skipped.`
          : `Janitor ${reviewType} review complete: ${typeResult.newFindings} new, ${typeResult.stillOpen} still open, ${typeResult.fixed} fixed, ${typeResult.configurationResolved} resolved by configuration, ${typeResult.leftOpen} excluded and left open.`,
      );
    }
  }
  return result;
}

export type ReviewAction = () => unknown | Promise<unknown>;

export function runReviewCommand(action: ReviewAction = review, argv?: string[]) {
  return cli(reviewCliOptions, () => action(), argv);
}

export default function reviewCommand() {
  return runReviewCommand();
}
