import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { GitError } from "#/review/errors";
import type {
  ChangedFile,
  ChangedFileStatus,
  GitCommandBoundary,
  PullRequestContext,
  ReviewDiff,
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
  mergeBase: string,
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
      mergeBase,
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
