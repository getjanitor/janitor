import { Context, Effect, Layer, Redacted } from "effect";
import { CodingReviewAgent } from "#/review/agent";
import { loadReviewConfig, type ReviewConfig } from "#/review/config";
import type { ConfigError, EventError } from "#/review/errors";
import { defaultGitCommand } from "#/review/git";
import { GitHubReviewClient, gitHubReviewFromClient } from "#/review/github";
import { loadReviewEnvironment, readPullRequestContext } from "#/review/runtime";
import type {
  GitCommandBoundary,
  GitHubReviewBoundary,
  PullRequestContext,
  ReviewAgentBoundary,
  ReviewEnvironment,
} from "#/review/types";

/** Validated process configuration: credentials, model selection and GitHub endpoints. */
export class Environment extends Context.Service<Environment, ReviewEnvironment>()(
  "janitor/Environment",
) {
  /** Reads the environment through the current `ConfigProvider`. */
  static readonly layer: Layer.Layer<Environment, ConfigError> =
    Layer.effect(Environment)(loadReviewEnvironment);
}

/** The pull request under review. */
export class PullRequest extends Context.Service<PullRequest, PullRequestContext>()(
  "janitor/PullRequest",
) {
  /** Reads the GitHub Actions pull-request event named by the environment. */
  static readonly layer: Layer.Layer<PullRequest, EventError, Environment> = Layer.effect(
    PullRequest,
  )(
    Effect.gen(function* () {
      const environment = yield* Environment;
      return yield* readPullRequestContext(
        environment.githubEventPath,
        environment.githubRepository,
      );
    }),
  );
}

export interface ReviewConfigLoaderShape {
  load(cwd: string): Effect.Effect<ReviewConfig, ConfigError>;
}

/** Loads `janitor.toml` from the checked-out repository. */
export class ReviewConfigLoader extends Context.Service<
  ReviewConfigLoader,
  ReviewConfigLoaderShape
>()("janitor/ReviewConfigLoader") {
  static readonly layer: Layer.Layer<ReviewConfigLoader> = Layer.succeed(ReviewConfigLoader)({
    load: loadReviewConfig,
  });
}

export class GitCommand extends Context.Service<GitCommand, GitCommandBoundary>()(
  "janitor/GitCommand",
) {
  /** Runs the local `git` executable. */
  static readonly layer: Layer.Layer<GitCommand> = Layer.succeed(GitCommand)(defaultGitCommand);
}

export class GitHubReview extends Context.Service<GitHubReview, GitHubReviewBoundary>()(
  "janitor/GitHubReview",
) {
  /** Octokit-backed client for the pull request's comments and review threads. */
  static readonly layer: Layer.Layer<GitHubReview, never, Environment | PullRequest> = Layer.effect(
    GitHubReview,
  )(
    Effect.gen(function* () {
      const environment = yield* Environment;
      const context = yield* PullRequest;
      return gitHubReviewFromClient(
        new GitHubReviewClient({
          token: Redacted.value(environment.githubToken),
          apiUrl: environment.githubApiUrl,
          graphqlUrl: environment.githubGraphqlUrl,
          context,
        }),
      );
    }),
  );
}

export interface ReviewReporterShape {
  /** High-level `[n/4]` review steps, shown unless quiet mode silences them. */
  step(message: string): Effect.Effect<void>;
  /** Detailed progress, shown only in verbose mode. */
  detail(message: string): Effect.Effect<void>;
}

export interface ReviewReporterOptions {
  write: (message: string) => void;
  verbose: boolean;
  quiet: boolean;
}

export class ReviewReporter extends Context.Service<ReviewReporter, ReviewReporterShape>()(
  "janitor/ReviewReporter",
) {
  /** `--verbose` shows steps and details; otherwise `--quiet` hides steps too. */
  static make(options: ReviewReporterOptions): ReviewReporterShape {
    const ignore = () => Effect.void;
    const write = (message: string) => Effect.sync(() => options.write(message));
    return {
      step: options.verbose || !options.quiet ? write : ignore,
      detail: options.verbose ? write : ignore,
    };
  }

  static layer(options: ReviewReporterOptions): Layer.Layer<ReviewReporter> {
    return Layer.succeed(ReviewReporter)(ReviewReporter.make(options));
  }

  static readonly silent: Layer.Layer<ReviewReporter> = Layer.succeed(ReviewReporter)({
    step: () => Effect.void,
    detail: () => Effect.void,
  });
}

export class ReviewAgent extends Context.Service<ReviewAgent, ReviewAgentBoundary>()(
  "janitor/ReviewAgent",
) {
  /** The pi coding agent, reporting its activity as verbose detail. */
  static readonly layer: Layer.Layer<ReviewAgent, never, Environment | ReviewReporter> =
    Layer.effect(ReviewAgent)(
      Effect.gen(function* () {
        const environment = yield* Environment;
        const reporter = yield* ReviewReporter;
        return new CodingReviewAgent(environment, (message) =>
          Effect.runSync(reporter.detail(message)),
        );
      }),
    );
}
