import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { minimatch } from "minimatch";
import { parse } from "smol-toml";
import type { ChangedFile } from "#/review/types";

export interface ReviewConfig {
  trackedPaths: string[];
}

const nonEmptyString = type("string > 0");
const janitorConfigSchema = type({
  version: nonEmptyString,
  review: {
    tracked_paths: nonEmptyString.array().atLeastLength(1),
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
    return { trackedPaths: config.review.tracked_paths };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path}: ${reason}`, { cause: error });
  }
}

export function shouldRunReview(files: ChangedFile[], trackedPaths: string[]): boolean {
  return files.some((file) =>
    [file.path, file.previousPath].some(
      (path) =>
        path !== undefined &&
        trackedPaths.some((pattern) =>
          minimatch(path, pattern, {
            dot: true,
            nonegate: true,
          }),
        ),
    ),
  );
}
