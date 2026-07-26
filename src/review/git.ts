import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ChangedFile,
  ChangedFileStatus,
  GitCommandBoundary,
  PullRequestContext,
  ReviewDiff,
} from "#/review/types";

const execFileAsync = promisify(execFile);

export const defaultGitCommand: GitCommandBoundary = {
  async run(args, cwd) {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 100 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      throw new Error(`git ${args.join(" ")} failed`, { cause: error });
    }
  },
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

async function patchForPath(
  git: GitCommandBoundary,
  cwd: string,
  mergeBase: string,
  headSha: string,
  paths: string[],
  unified: number,
): Promise<string> {
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

export async function collectReviewDiff(
  cwd: string,
  context: PullRequestContext,
  git: GitCommandBoundary = defaultGitCommand,
): Promise<ReviewDiff> {
  const localHead = (await git.run(["rev-parse", "HEAD"], cwd)).trim();
  if (localHead !== context.headSha) {
    throw new Error(
      `Checked-out HEAD ${localHead} does not match pull-request head ${context.headSha}`,
    );
  }

  const mergeBase = (await git.run(["merge-base", context.baseSha, context.headSha], cwd)).trim();
  if (mergeBase.length === 0) {
    throw new Error("Unable to determine the pull-request merge base");
  }

  const nameStatus = await git.run(
    ["diff", "--find-renames", "--name-status", "-z", mergeBase, context.headSha],
    cwd,
  );
  const entries = parseNameStatus(nameStatus);
  const files = await Promise.all(
    entries.map(async (entry): Promise<ChangedFile> => {
      // Supplying both sides preserves Git's rename/copy detection. Restricting a rename
      // to only its new path makes Git render it as an entirely added file, which does not
      // match the line locations accepted by GitHub's pull-request diff API.
      const paths = entry.previousPath ? [entry.previousPath, entry.path] : [entry.path];
      const [patch, locationPatch] = await Promise.all([
        patchForPath(git, cwd, mergeBase, context.headSha, paths, 20),
        patchForPath(git, cwd, mergeBase, context.headSha, paths, 0),
      ]);
      return {
        ...entry,
        patch,
        commentableLines: parseCommentableLines(locationPatch),
      };
    }),
  );

  return { mergeBase, headSha: context.headSha, files };
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
