import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { Effect } from "effect";
import { minimatch } from "minimatch";
import { parse } from "smol-toml";
import { ConfigError } from "#/review/errors";
import { THINKING_LEVELS, type ChangedFile, type ThinkingLevel } from "#/review/types";

export interface ReviewConfig {
  trackedPaths: string[];
  trackSpend: boolean;
  /**
   * Re-reviews only what changed since the last successful review. Defaults to true;
   * false always reviews the whole pull request, even at an already reviewed commit.
   */
  incremental?: boolean;
  /** When set, only pull requests whose head branch matches one of these globs are reviewed. */
  includedBranches?: string[];
  /** Pull requests whose head branch matches one of these globs are never reviewed. */
  excludedBranches?: string[];
  /** Model reasoning effort; omitted means the agent library's default. */
  thinkingLevel?: ThinkingLevel;
}

const nonEmptyString = type("string > 0");
const janitorConfigSchema = type({
  version: nonEmptyString,
  review: {
    tracked_paths: nonEmptyString.array().atLeastLength(1),
    "track_spend?": "boolean",
    "incremental?": "boolean",
    "included_branches?": nonEmptyString.array().atLeastLength(1),
    "excluded_branches?": nonEmptyString.array(),
    "thinking_level?": type.enumerated(...THINKING_LEVELS),
  },
});

export const loadReviewConfig = Effect.fn("janitor.config.load")(function* (cwd: string) {
  const path = join(cwd, "janitor.toml");
  const document = yield* Effect.tryPromise({
    try: async (): Promise<unknown> => parse(await readFile(path, "utf8")),
    catch: (cause) => new ConfigError({ message: `Unable to load ${path}`, source: path, cause }),
  });

  return yield* Effect.try({
    try: (): ReviewConfig => {
      const config = janitorConfigSchema.assert(document);
      return {
        trackedPaths: config.review.tracked_paths,
        trackSpend: config.review.track_spend ?? false,
        incremental: config.review.incremental ?? true,
        includedBranches: config.review.included_branches,
        excludedBranches: config.review.excluded_branches,
        thinkingLevel: config.review.thinking_level,
      };
    },
    catch: (cause) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return new ConfigError({ message: `Invalid ${path}: ${reason}`, source: path, cause });
    },
  });
});

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(value, pattern, { dot: true, nonegate: true }));
}

export function shouldRunReview(files: ChangedFile[], trackedPaths: string[]): boolean {
  return files.some((file) =>
    [file.path, file.previousPath].some(
      (path) => path !== undefined && matchesAny(path, trackedPaths),
    ),
  );
}

/** Exclusions win over inclusions, so a branch matching both is skipped. */
export function shouldReviewBranch(
  headRef: string,
  config: Pick<ReviewConfig, "includedBranches" | "excludedBranches">,
): boolean {
  if (config.excludedBranches !== undefined && matchesAny(headRef, config.excludedBranches)) {
    return false;
  }
  return config.includedBranches === undefined || matchesAny(headRef, config.includedBranches);
}
