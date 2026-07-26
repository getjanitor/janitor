import { loadReviewConfig, shouldRunReview } from "#/review/config";
import { collectReviewDiff, isCommentableLocation } from "#/review/git";
import {
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  renderFindingComment,
  renderGeneralComment,
} from "#/review/markers";
import type {
  GitCommandBoundary,
  GitHubReviewBoundary,
  PullRequestContext,
  ReviewAgentBoundary,
} from "#/review/types";

const GITHUB_COMMENT_LIMIT = 65_536;

export interface ExecuteReviewOptions {
  cwd: string;
  context: PullRequestContext;
  git: GitCommandBoundary;
  github: GitHubReviewBoundary;
  agent: ReviewAgentBoundary;
  configLoader?: typeof loadReviewConfig;
}

export interface ExecuteReviewResult {
  skipped: boolean;
  newFindings: number;
  stillOpen: number;
  fixed: number;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Model review ${name} must not be empty`);
  }
  if (value.includes("<!-- janitor:")) {
    throw new Error(`Model review ${name} contains a reserved Janitor marker`);
  }
}

function validateModelResult(
  result: Awaited<ReturnType<ReviewAgentBoundary["run"]>>,
  previous: ReturnType<typeof findOpenJanitorFindings>,
  diff: Awaited<ReturnType<typeof collectReviewDiff>>,
): void {
  if (result.general === undefined) {
    throw new Error("Model review did not submit a general result");
  }
  requireNonEmpty(result.general.summary, "summary");
  requireNonEmpty(result.general.mermaid, "Mermaid diagram");
  requireNonEmpty(result.general.confidenceReason, "confidence reason");
  if (
    !Number.isInteger(result.general.confidence) ||
    result.general.confidence < 1 ||
    result.general.confidence > 5
  ) {
    throw new Error("Model review confidence must be an integer from 1 to 5");
  }
  if (!/^(?:flowchart|graph)\b/u.test(result.general.mermaid.trim())) {
    throw new Error('Model review Mermaid diagram must begin with "flowchart" or "graph"');
  }
  if (result.general.mermaid.includes("```")) {
    throw new Error("Model review Mermaid diagram must not contain Markdown fences");
  }

  const expectedThreadIds = new Set(previous.map((finding) => finding.threadId));
  const dispositionIds = new Set<string>();
  for (const disposition of result.dispositions) {
    if (!expectedThreadIds.has(disposition.threadId)) {
      throw new Error(`Model review returned unknown thread ${disposition.threadId}`);
    }
    if (dispositionIds.has(disposition.threadId)) {
      throw new Error(`Model review returned duplicate disposition for ${disposition.threadId}`);
    }
    dispositionIds.add(disposition.threadId);
    if (disposition.status === "fixed") {
      requireNonEmpty(disposition.reason, `fixed reason for ${disposition.threadId}`);
    }
  }
  const missing = [...expectedThreadIds].filter((threadId) => !dispositionIds.has(threadId));
  if (missing.length > 0) {
    throw new Error(`Model review omitted dispositions for: ${missing.join(", ")}`);
  }

  const findingKeys = new Set<string>();
  for (const finding of result.findings) {
    requireNonEmpty(finding.title, "finding title");
    requireNonEmpty(finding.body, "finding body");
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) {
      throw new Error(`Model review returned invalid severity ${finding.severity}`);
    }
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error(`Model review returned invalid line ${finding.line}`);
    }
    if (!isCommentableLocation(diff, finding.path, finding.side, finding.line)) {
      throw new Error(
        `Model finding location is not a changed line: ${finding.path}:${finding.line} (${finding.side})`,
      );
    }
    const key = `${finding.path}\0${finding.side}\0${finding.line}\0${finding.title.trim().toLowerCase()}`;
    if (findingKeys.has(key)) {
      throw new Error(
        `Model review returned a duplicate finding at ${finding.path}:${finding.line}`,
      );
    }
    findingKeys.add(key);
    if (renderFindingComment(finding).length > GITHUB_COMMENT_LIMIT) {
      throw new Error(`Model finding at ${finding.path}:${finding.line} exceeds GitHub's limit`);
    }
  }

  const stillPresentIds = new Set(
    result.dispositions
      .filter((disposition) => disposition.status === "still_present")
      .map((disposition) => disposition.threadId),
  );
  for (const existing of previous) {
    if (
      stillPresentIds.has(existing.threadId) &&
      existing.line !== null &&
      result.findings.some(
        (finding) => finding.path === existing.path && finding.line === existing.line,
      )
    ) {
      throw new Error(
        `Model review duplicated still-open thread ${existing.threadId} at ${existing.path}:${existing.line}`,
      );
    }
  }
}

export async function executeReview(options: ExecuteReviewOptions): Promise<ExecuteReviewResult> {
  const config = await (options.configLoader ?? loadReviewConfig)(options.cwd);
  const diff = await collectReviewDiff(options.cwd, options.context, options.git);
  if (diff.files.length === 0 || !shouldRunReview(diff.files, config.trackedPaths)) {
    return { skipped: true, newFindings: 0, stillOpen: 0, fixed: 0 };
  }

  const [comments, threads] = await Promise.all([
    options.github.listGeneralComments(),
    options.github.listReviewThreads(),
  ]);
  const generalComment = findJanitorGeneralComment(comments);
  const previousFindings = findOpenJanitorFindings(threads);
  const modelResult = await options.agent.run({
    cwd: options.cwd,
    context: options.context,
    diff,
    previousFindings,
  });
  validateModelResult(modelResult, previousFindings, diff);

  const fixed = modelResult.dispositions.filter((disposition) => disposition.status === "fixed");
  const stillOpen = modelResult.dispositions.filter(
    (disposition) => disposition.status === "still_present",
  );
  const generalBody = renderGeneralComment(modelResult.general!, {
    newFindings: modelResult.findings.length,
    stillOpen: stillOpen.length,
    fixed: fixed.length,
  });
  if (generalBody.length > GITHUB_COMMENT_LIMIT) {
    throw new Error("General review exceeds GitHub's comment size limit");
  }

  for (const finding of modelResult.findings) {
    await options.github.createInlineComment(
      finding,
      renderFindingComment(finding),
      options.context.headSha,
    );
  }
  for (const disposition of fixed) {
    await options.github.resolveThread(disposition.threadId);
  }
  if (generalComment === undefined) {
    await options.github.createGeneralComment(generalBody);
  } else {
    await options.github.updateGeneralComment(generalComment.id, generalBody);
  }

  return {
    skipped: false,
    newFindings: modelResult.findings.length,
    stillOpen: stillOpen.length,
    fixed: fixed.length,
  };
}
