import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { minimatch } from "minimatch";
import { parse } from "smol-toml";
import type { ChangedFile, ReviewDiff } from "#/review/types";

export type DisabledFindingsPolicy = "leave_open" | "review" | "resolve";

export interface ReviewTypeConfig {
  paths: string[];
  disabledFindings: DisabledFindingsPolicy;
}

export interface ReviewConfig {
  code: ReviewTypeConfig;
  security: ReviewTypeConfig;
}

const nonEmptyString = type("string > 0");
const disabledFindingsSchema = type("'leave_open' | 'review' | 'resolve'");
const reviewTypeSchema = {
  paths: nonEmptyString.array(),
  "disabled_findings?": disabledFindingsSchema,
};
const janitorConfigSchema = type({
  version: nonEmptyString,
  review: {
    code: reviewTypeSchema,
    security: reviewTypeSchema,
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
      code: {
        paths: config.review.code.paths,
        disabledFindings: config.review.code.disabled_findings ?? "leave_open",
      },
      security: {
        paths: config.review.security.paths,
        disabledFindings: config.review.security.disabled_findings ?? "leave_open",
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path}: ${reason}`, { cause: error });
  }
}

export function pathMatchesReviewPaths(path: string, paths: string[]): boolean {
  return paths.some((pattern) =>
    minimatch(path, pattern, {
      dot: true,
      nonegate: true,
    }),
  );
}

export function fileMatchesReviewPaths(file: ChangedFile, paths: string[]): boolean {
  return [file.path, file.previousPath].some(
    (path) => path !== undefined && pathMatchesReviewPaths(path, paths),
  );
}

export function filterReviewDiff(diff: ReviewDiff, paths: string[]): ReviewDiff {
  return {
    ...diff,
    files: diff.files.filter((file) => fileMatchesReviewPaths(file, paths)),
  };
}

export function findingPathMatchesReviewPaths(
  path: string,
  diff: ReviewDiff,
  paths: string[],
): boolean {
  const changedFile = diff.files.find((file) => file.path === path || file.previousPath === path);
  return changedFile === undefined
    ? pathMatchesReviewPaths(path, paths)
    : fileMatchesReviewPaths(changedFile, paths);
}
