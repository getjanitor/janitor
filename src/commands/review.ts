import { cli, type CliOptions } from "cleye";
import { Cause, ConfigProvider, Effect, Exit, Layer } from "effect";
import type { ConfigError, EventError } from "#/review/errors";
import { formatReviewFailure } from "#/review/failure";
import {
  executeReview,
  type ExecuteReviewResult,
  type ReviewServices,
} from "#/review/orchestrator";
import { environmentConfigProvider } from "#/review/runtime";
import {
  Environment,
  GitCommand,
  GitHubReview,
  PullRequest,
  ReviewAgent,
  ReviewConfigLoader,
  ReviewReporter,
  type ReviewReporterOptions,
} from "#/review/services";

export const reviewCliOptions = {
  help: {
    description: "Review the current GitHub pull request for quality and security issues",
  },
  flags: {
    verbose: {
      type: Boolean,
      description: "Show detailed review and agent progress logs",
    },
    quiet: {
      type: Boolean,
      description: "Hide review step logs (ignored with --verbose)",
    },
  },
  strictFlags: true,
} satisfies CliOptions;

export interface ReviewOptions {
  verbose?: boolean;
  quiet?: boolean;
}

/**
 * The replaceable parts of the review stack. Each one defaults to its live layer;
 * tests and a hosted mode can supply their own.
 */
export interface ReviewLayers {
  pullRequest: Layer.Layer<PullRequest, EventError | ConfigError, Environment>;
  git: Layer.Layer<GitCommand, never, Environment>;
  github: Layer.Layer<GitHubReview, never, Environment | PullRequest>;
  agent: Layer.Layer<ReviewAgent, never, Environment | ReviewReporter>;
  config: Layer.Layer<ReviewConfigLoader>;
}

export interface ReviewDependencies {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  layers?: Partial<ReviewLayers>;
  /** Receives step, detail and summary lines. Defaults to `console.log`. */
  report?: (message: string) => void;
  /** Receives the formatted failure. Defaults to `console.error`. */
  reportError?: (message: string) => void;
}

export interface ReviewLayerOptions {
  environment: NodeJS.ProcessEnv;
  reporter: ReviewReporterOptions;
  layers?: Partial<ReviewLayers>;
}

/** Builds the complete service stack `executeReview` runs against. */
export function reviewLayer(
  options: ReviewLayerOptions,
): Layer.Layer<ReviewServices | Environment, ConfigError | EventError> {
  const layers = options.layers ?? {};
  const base = Layer.mergeAll(
    Environment.layer.pipe(
      Layer.provide(ConfigProvider.layer(environmentConfigProvider(options.environment))),
    ),
    ReviewReporter.layer(options.reporter),
  );
  const pullRequest = (layers.pullRequest ?? PullRequest.layer).pipe(Layer.provideMerge(base));
  return Layer.mergeAll(
    layers.git ?? GitCommand.layer,
    layers.github ?? GitHubReview.layer,
    layers.agent ?? ReviewAgent.layer,
    layers.config ?? ReviewConfigLoader.layer,
  ).pipe(Layer.provideMerge(pullRequest));
}

function summarize(result: ExecuteReviewResult): string {
  return result.skipped
    ? `Janitor review skipped: ${result.skipReason ?? "no review was needed."}`
    : `Janitor review complete: ${result.newFindings} new, ${result.stillOpen} still open, ${result.fixed} fixed, ${result.dismissed} dismissed.`;
}

/**
 * Runs a review. On failure the formatted error goes to `reportError` and the
 * promise rejects with the underlying tagged error.
 */
export async function review(
  options: ReviewOptions = {},
  dependencies: ReviewDependencies = {},
): Promise<ExecuteReviewResult> {
  const report = dependencies.report ?? console.log;
  const reportError = dependencies.reportError ?? console.error;
  const environment = dependencies.environment ?? process.env;
  const program = executeReview({ cwd: dependencies.cwd ?? process.cwd() }).pipe(
    Effect.provide(
      reviewLayer({
        environment,
        reporter: {
          write: report,
          verbose: options.verbose === true || environment.JANITOR_VERBOSE === "1",
          quiet: options.quiet === true || environment.JANITOR_QUIET === "1",
        },
        layers: dependencies.layers,
      }),
    ),
  );

  const exit = await Effect.runPromiseExit(program);
  if (Exit.isFailure(exit)) {
    reportError(formatReviewFailure(exit.cause));
    throw Cause.squash(exit.cause);
  }
  report(summarize(exit.value));
  return exit.value;
}

export type ReviewAction = (options: ReviewOptions) => unknown | Promise<unknown>;

/** The CLI action: `review` has already printed the failure, so only the exit code is left. */
export async function runReview(options: ReviewOptions): Promise<ExecuteReviewResult | undefined> {
  try {
    return await review(options);
  } catch {
    process.exitCode = 1;
    return undefined;
  }
}

export function runReviewCommand(action: ReviewAction = runReview, argv?: string[]) {
  return cli(
    reviewCliOptions,
    ({ flags }) => action({ verbose: flags.verbose ?? false, quiet: flags.quiet ?? false }),
    argv,
  );
}

export default function reviewCommand() {
  return runReviewCommand();
}
