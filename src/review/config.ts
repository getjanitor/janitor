import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { Effect } from "effect";
import { minimatch } from "minimatch";
import { parse } from "smol-toml";
import { ConfigError } from "#/review/errors";
import type { ChangedFile } from "#/review/types";

export interface ReviewConfig {
  trackedPaths: string[];
  trackSpend: boolean;
  /** When set, only pull requests whose head branch matches one of these globs are reviewed. */
  includedBranches?: string[];
  /** Pull requests whose head branch matches one of these globs are never reviewed. */
  excludedBranches?: string[];
}

const nonEmptyString = type("string > 0");
const janitorConfigSchema = type({
  version: nonEmptyString,
  review: {
    tracked_paths: nonEmptyString.array().atLeastLength(1),
    "track_spend?": "boolean",
    "included_branches?": nonEmptyString.array().atLeastLength(1),
    "excluded_branches?": nonEmptyString.array(),
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
        includedBranches: config.review.included_branches,
        excludedBranches: config.review.excluded_branches,
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
