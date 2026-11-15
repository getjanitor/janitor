import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { GitError } from "#/review/errors";
import type {
  ChangedFile,
  ChangedFileStatus,
  GitCommandBoundary,
  IncrementalFile,
  IncrementalReview,
  PullRequestContext,
  ReviewDiff,
  ReviewedState,
} from "#/review/types";

const execFileAsync = promisify(execFile);

export const defaultGitCommand: GitCommandBoundary = {
  run: (args, cwd) =>
    Effect.tryPromise({
      try: async () => {
        const { stdout } = await execFileAsync("git", args, {
          cwd,
          encoding: "utf8",
          maxBuffer: 100 * 1024 * 1024,
        });
        return stdout;
      },
      catch: (cause) => new GitError({ message: `git ${args.join(" ")} failed`, args, cause }),
    }),
};

interface NameStatusEntry {
  path: string;
  previousPath?: string;
  status: ChangedFileStatus;
}

function mapStatus(status: string): ChangedFileStatus {
  switch (status[0]) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

export function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    if (statusToken === undefined || statusToken.length === 0) {
      throw new Error("Malformed git name-status output");
    }
    const status = mapStatus(statusToken);
    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (previousPath === undefined || path === undefined) {
        throw new Error("Malformed rename/copy in git name-status output");
      }
      entries.push({ status, previousPath, path });
    } else {
      const path = tokens[index++];
      if (path === undefined) {
        throw new Error("Malformed path in git name-status output");
      }
      entries.push({ status, path });
    }
  }
  return entries;
}

export function parseCommentableLines(patch: string): {
  left: ReadonlySet<number>;
  right: ReadonlySet<number>;
} {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      left.add(oldLine++);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      right.add(newLine++);
    } else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    } else if (!line.startsWith("\\")) {
      inHunk = false;
    }
  }
  return { left, right };
}

function patchForPath(
  git: GitCommandBoundary,
  cwd: string,
  fromSha: string,
  headSha: string,
  paths: string[],
  unified: number,
): Effect.Effect<string, GitError> {
  return git.run(
    [
      "diff",
      "--find-renames",
      "--no-ext-diff",
      "--no-color",
      `--unified=${unified}`,
      fromSha,
      headSha,
      "--",
      ...paths,
    ],
    cwd,
  );
}

export const collectReviewDiff = Effect.fn("janitor.git.collect_review_diff")(function* (
  cwd: string,
  context: PullRequestContext,
  git: GitCommandBoundary = defaultGitCommand,
) {
  const localHead = (yield* git.run(["rev-parse", "HEAD"], cwd)).trim();
  if (localHead !== context.headSha) {
    return yield* new GitError({
      message: `Checked-out HEAD ${localHead} does not match pull-request head ${context.headSha}`,
      args: ["rev-parse", "HEAD"],
    });
  }

  const mergeBaseArgs = ["merge-base", context.baseSha, context.headSha];
  const mergeBase = (yield* git.run(mergeBaseArgs, cwd)).trim();
  if (mergeBase.length === 0) {
    return yield* new GitError({
      message: "Unable to determine the pull-request merge base",
      args: mergeBaseArgs,
    });
  }

  const nameStatusArgs = [
    "diff",
    "--find-renames",
    "--name-status",
    "-z",
    mergeBase,
    context.headSha,
  ];
  const nameStatus = yield* git.run(nameStatusArgs, cwd);
  const entries = yield* Effect.try({
    try: () => parseNameStatus(nameStatus),
    catch: (cause) =>
      new GitError({
        message: cause instanceof Error ? cause.message : String(cause),
        args: nameStatusArgs,
        cause,
      }),
  });
  const files = yield* Effect.forEach(
    entries,
    (entry) => {
      // Supplying both sides preserves Git's rename/copy detection. Restricting a rename
      // to only its new path makes Git render it as an entirely added file, which does not
      // match the line locations accepted by GitHub's pull-request diff API.
      const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path];
      return Effect.all(
        [
          patchForPath(git, cwd, mergeBase, context.headSha, paths, 20),
          patchForPath(git, cwd, mergeBase, context.headSha, paths, 0),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(
          ([patch, locationPatch]): ChangedFile => ({
            ...entry,
            patch,
            commentableLines: parseCommentableLines(locationPatch),
          }),
        ),
      );
    },
    { concurrency: "unbounded" },
  );

  const diff: ReviewDiff = { mergeBase, headSha: context.headSha, files };
  return diff;
});

/** Why an incremental review was not possible, so the whole pull request is reviewed. */
export interface FullReviewFallback {
  fallback: string;
}

/**
 * Narrows a re-review to the pull-request files whose content changed since
 * `previous.headSha`. Changes outside the pull-request diff, such as those brought in
 * by merging the base branch, are left out because only pull-request files are
 * compared and only lines that are also part of the pull-request diff are kept.
 */
export const collectIncrementalReview = Effect.fn("janitor.git.collect_incremental_review")(
  function* (
    cwd: string,
    diff: ReviewDiff,
    previous: ReviewedState,
    git: GitCommandBoundary = defaultGitCommand,
  ) {
    // Exits non-zero when the commit is unknown (e.g. a shallow clone) or was rewritten
    // away by a force-push or rebase. Either way the previous review no longer anchors
    // cleanly onto head, so the whole pull request is reviewed again.
    const ancestor = yield* git
      .run(["merge-base", "--is-ancestor", previous.headSha, diff.headSha], cwd)
      .pipe(
        Effect.as(true),
        Effect.catchTag("GitError", () => Effect.succeed(false)),
      );
    if (!ancestor) {
      const fallback: FullReviewFallback = {
        fallback: `last reviewed commit ${previous.headSha} is not an ancestor of head (force-push, rebase, or missing history).`,
      };
      return fallback;
    }

    const files = yield* Effect.forEach(
      diff.files,
      (file) => {
        const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
        return Effect.all(
          [
            patchForPath(git, cwd, previous.headSha, diff.headSha, paths, 20),
            patchForPath(git, cwd, previous.headSha, diff.headSha, paths, 0),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(([patch, locationPatch]): IncrementalFile | undefined => {
            if (patch.trim().length === 0) return undefined;
            const changed = parseCommentableLines(locationPatch).right;
            const rightLines = new Set(
              [...changed].filter((line) => file.commentableLines.right.has(line)),
            );
            return {
              path: file.path,
              ...(file.previousPath ? { previousPath: file.previousPath } : {}),
              patch,
              rightLines,
            };
          }),
        );
      },
      { concurrency: "unbounded" },
    );
    const incremental: IncrementalReview = {
      previous,
      files: files.filter((file): file is IncrementalFile => file !== undefined),
    };
    return incremental;
  },
);

/** Whether an incremental review covers this location: any changed line of a changed file. */
export function isIncrementalLocation(
  incremental: IncrementalReview,
  path: string,
  side: "LEFT" | "RIGHT",
  line: number,
): boolean {
  const file = incremental.files.find((candidate) => candidate.path === path);
  if (file === undefined) return false;
  // Deleted lines are numbered against the merge base, which the last reviewed commit
  // cannot map onto, so any deleted line of a changed file stays in scope.
  return side === "LEFT" || file.rightLines.has(line);
}

export function isCommentableLocation(
  diff: ReviewDiff,
  path: string,
  side: "LEFT" | "RIGHT",
  line: number,
): boolean {
  const file = diff.files.find((candidate) => candidate.path === path);
  return side === "LEFT"
    ? (file?.commentableLines.left.has(line) ?? false)
    : (file?.commentableLines.right.has(line) ?? false);
}
