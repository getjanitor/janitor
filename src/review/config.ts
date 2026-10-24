import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { minimatch } from "minimatch";
import { parse } from "smol-toml";
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

export async function loadReviewConfig(cwd: string): Promise<ReviewConfig> {
  const path = join(cwd, "janitor.toml");
  let document: unknown;
  try {
    document = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load ${path}`, { cause: error });
  }

  try {
    const config = janitorConfigSchema.assert(document);
    return {
      trackedPaths: config.review.tracked_paths,
      trackSpend: config.review.track_spend ?? false,
      includedBranches: config.review.included_branches,
      excludedBranches: config.review.excluded_branches,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path}: ${reason}`, { cause: error });
  }
}

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
