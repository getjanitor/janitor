import { loadReviewConfig, shouldRunReview } from "#/review/config";
import { collectReviewDiff, isCommentableLocation } from "#/review/git";
import {
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  reconcileReviewDescription,
  renderFindingComment,
  renderGeneralComment,
  renderGeneralCommentStatus,
  renderOutsideDiffFindings,
  type ReviewDescriptionStatus,
} from "#/review/markers";
import { requireValidModelText } from "#/review/model_result";
import {
  appendSpendEntry,
  completedSpendEntry,
  createReviewUsageAccumulator,
  parseSpendHistory,
  trimSpendHistoryToFit,
} from "#/review/spend";
import type {
  GitCommandBoundary,
  GitHubReviewBoundary,
  NewFinding,
  PullRequestContext,
  ReviewAgentBoundary,
  ReviewSpendEntry,
} from "#/review/types";

const GITHUB_COMMENT_LIMIT = 65_536;

export interface ExecuteReviewOptions {
  cwd: string;
  context: PullRequestContext;
  git: GitCommandBoundary;
  github: GitHubReviewBoundary;
  agent: ReviewAgentBoundary;
  configLoader?: typeof loadReviewConfig;
  report?: (message: string) => void;
}

export interface ExecuteReviewResult {
  skipped: boolean;
  newFindings: number;
  stillOpen: number;
  fixed: number;
}

function validateModelResult(
  result: Awaited<ReturnType<ReviewAgentBoundary["run"]>>,
  previous: ReturnType<typeof findOpenJanitorFindings>,
): void {
  if (result.general === undefined) {
    throw new Error("Model review did not submit a general result");
  }
  requireValidModelText(result.general.summary, "summary");
  requireValidModelText(result.general.mermaid, "Mermaid diagram");
  requireValidModelText(result.general.confidenceReason, "confidence reason");
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
      requireValidModelText(disposition.reason, `fixed reason for ${disposition.threadId}`);
    }
  }
  const missing = [...expectedThreadIds].filter((threadId) => !dispositionIds.has(threadId));
  if (missing.length > 0) {
    throw new Error(`Model review omitted dispositions for: ${missing.join(", ")}`);
  }

  const findingKeys = new Set<string>();
  for (const finding of result.findings) {
    requireValidModelText(finding.title, "finding title");
    requireValidModelText(finding.body, "finding body");
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) {
      throw new Error(`Model review returned invalid severity ${finding.severity}`);
    }
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error(`Model review returned invalid line ${finding.line}`);
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

type DescriptionStatusPublication = "updated" | "unchanged" | "failed";

async function publishDescriptionStatus(
  options: ExecuteReviewOptions,
  status: ReviewDescriptionStatus,
  report: (message: string) => void,
): Promise<DescriptionStatusPublication> {
  try {
    const body = await options.github.getPullRequestBody();
    const updated = reconcileReviewDescription(body, options.context.headSha, status);
    if (updated === body) return "unchanged";
    await options.github.updatePullRequestBody(updated);
    return "updated";
  } catch (error) {
    report(`Unable to publish pull request ${status} status: ${errorMessage(error)}`);
    return "failed";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// GitHub answers 422 when an inline comment's line cannot be resolved against
// its own view of the pull-request diff, even if the local diff accepted it.
function isUnprocessableLocation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 422;
}

export async function executeReview(options: ExecuteReviewOptions): Promise<ExecuteReviewResult> {
  const report = options.report ?? (() => undefined);
  let generalCommentId: number | undefined;
  let trackSpend = false;
  let spendHistory: ReviewSpendEntry[] = [];
  let agentInvoked = false;
  const usage = createReviewUsageAccumulator();

  try {
    report(`Starting Janitor review for pull request #${options.context.number}.`);
    const runningStatus = await publishDescriptionStatus(options, "running", report);
    if (runningStatus === "updated") report("Pull request status set to running.");
    if (runningStatus === "unchanged") report("Pull request status already running.");

    report("Loading review configuration and collecting the pull request diff.");
    const config = await (options.configLoader ?? loadReviewConfig)(options.cwd);
    trackSpend = config.trackSpend;
    const diff = await collectReviewDiff(options.cwd, options.context, options.git);
    report(`Collected ${diff.files.length} changed file(s).`);
    if (diff.files.length === 0 || !shouldRunReview(diff.files, config.trackedPaths)) {
      report("No changed path matched review.tracked_paths; skipping agent review.");
      const skippedStatus = await publishDescriptionStatus(options, "skipped", report);
      if (skippedStatus === "updated") report("Pull request status set to skipped.");
      if (skippedStatus === "unchanged") report("Pull request skipped status unchanged.");
      return { skipped: true, newFindings: 0, stillOpen: 0, fixed: 0 };
    }

    report("Loading previous Janitor feedback from GitHub.");
    const [comments, threads] = await Promise.all([
      options.github.listGeneralComments(),
      options.github.listReviewThreads(),
    ]);
    const generalComment = findJanitorGeneralComment(comments);
    if (trackSpend && generalComment !== undefined) {
      spendHistory = parseSpendHistory(generalComment.body);
    }
    const previousFindings = findOpenJanitorFindings(threads);
    report(`Loaded ${previousFindings.length} unresolved Janitor finding(s).`);

    const runningGeneralBody = renderGeneralCommentStatus(
      "running",
      trackSpend ? spendHistory : undefined,
    );
    if (generalComment === undefined) {
      generalCommentId = await options.github.createGeneralComment(runningGeneralBody);
    } else {
      generalCommentId = generalComment.id;
      await options.github.updateGeneralComment(generalCommentId, runningGeneralBody);
    }
    report("General review comment set to running.");

    report("Starting the coding review agent.");
    agentInvoked = true;
    const modelResult = await options.agent.run(
      {
        cwd: options.cwd,
        context: options.context,
        diff,
        previousFindings,
      },
      trackSpend ? usage.report : undefined,
    );
    report("Coding review agent finished; validating its output.");
    validateModelResult(modelResult, previousFindings);
    report("Agent output validated successfully.");

    const inlineFindings: NewFinding[] = [];
    const outsideDiffFindings: NewFinding[] = [];
    for (const finding of modelResult.findings) {
      if (isCommentableLocation(diff, finding.path, finding.side, finding.line)) {
        inlineFindings.push(finding);
      } else {
        report(
          `Finding at ${finding.path}:${finding.line} (${finding.side}) is outside the diff; it will be included in the general comment.`,
        );
        outsideDiffFindings.push(finding);
      }
    }

    const fixed = modelResult.dispositions.filter((disposition) => disposition.status === "fixed");
    const stillOpen = modelResult.dispositions.filter(
      (disposition) => disposition.status === "still_present",
    );
    const successfulSpendHistory = trackSpend
      ? appendSpendEntry(
          spendHistory,
          completedSpendEntry(options.context.headSha, "succeeded", usage.snapshot()),
        )
      : [];
    type OutsideDiffDetail = Parameters<typeof renderOutsideDiffFindings>[1];
    const renderGeneralBody = (
      outsideDiff: readonly NewFinding[],
      unresolvedFixed: number,
      details: readonly OutsideDiffDetail[] = ["full", "compact", "count"],
    ): { body: string; detail: OutsideDiffDetail } => {
      for (const detail of details) {
        const { body } = trimSpendHistoryToFit(
          successfulSpendHistory,
          (retained) =>
            renderGeneralComment(
              modelResult.general!,
              {
                newFindings: modelResult.findings.length,
                stillOpen: stillOpen.length,
                fixed: fixed.length - unresolvedFixed,
                unresolvedFixed,
              },
              trackSpend ? retained : undefined,
              renderOutsideDiffFindings(outsideDiff, detail),
            ),
          GITHUB_COMMENT_LIMIT,
        );
        if (body.length <= GITHUB_COMMENT_LIMIT) return { body, detail };
      }
      throw new Error("General review exceeds GitHub's comment size limit");
    };
    // Fail before any GitHub mutation unless the worst case fits: every finding
    // folded after a 422 and every fixed thread left unresolved. The count-only
    // section grows only with the number of digits, so the final render is then
    // guaranteed to fit at some detail level.
    renderGeneralBody(modelResult.findings, fixed.length, ["count"]);

    report("Publishing validated review feedback to GitHub.");
    for (const finding of inlineFindings) {
      try {
        await options.github.createInlineComment(
          finding,
          renderFindingComment(finding),
          options.context.headSha,
        );
      } catch (error) {
        if (!isUnprocessableLocation(error)) throw error;
        report(
          `GitHub rejected the inline location ${finding.path}:${finding.line} (${finding.side}): ${errorMessage(error)}; it will be included in the general comment.`,
        );
        outsideDiffFindings.push(finding);
      }
    }
    let unresolvedFixed = 0;
    for (const disposition of fixed) {
      // A thread GitHub refuses to resolve (e.g. a token without permission)
      // stays open; it must not discard the rest of an otherwise complete review.
      try {
        await options.github.resolveThread(disposition.threadId);
      } catch (error) {
        unresolvedFixed++;
        report(
          `Unable to resolve fixed thread ${disposition.threadId}: ${errorMessage(error)}; it was left open.`,
        );
      }
    }
    const general = renderGeneralBody(outsideDiffFindings, unresolvedFixed);
    if (general.detail === "count") {
      for (const finding of outsideDiffFindings) {
        report(
          `Finding outside the diff omitted from the general comment: ${finding.severity.toUpperCase()}: ${finding.title} at ${finding.path}:${finding.line} (${finding.side})`,
        );
      }
    }
    await options.github.updateGeneralComment(generalCommentId, general.body);
    if (trackSpend) spendHistory = successfulSpendHistory;
    report("Review feedback published to GitHub.");

    const completionStatus =
      modelResult.general!.confidence === 5 ? "complete-max-confidence" : "complete";
    const completionPublication = await publishDescriptionStatus(options, completionStatus, report);
    if (completionPublication === "updated") report("Pull request status set to complete.");
    if (completionPublication === "unchanged") {
      report("Skipped a stale pull request status update for another head.");
    }

    return {
      skipped: false,
      newFindings: modelResult.findings.length,
      stillOpen: stillOpen.length,
      fixed: fixed.length,
    };
  } catch (error) {
    report(`Janitor review failed: ${errorMessage(error)}`);
    if (generalCommentId !== undefined) {
      try {
        if (trackSpend && agentInvoked) {
          spendHistory = appendSpendEntry(
            spendHistory,
            completedSpendEntry(options.context.headSha, "failed", usage.snapshot()),
          );
        }
        const { body: failedBody } = trimSpendHistoryToFit(
          trackSpend ? spendHistory : [],
          (retained) => renderGeneralCommentStatus("failed", trackSpend ? retained : undefined),
          GITHUB_COMMENT_LIMIT,
        );
        await options.github.updateGeneralComment(generalCommentId, failedBody);
        report("General review comment set to failed.");
      } catch (commentError) {
        report(`Unable to update the failed general review comment: ${errorMessage(commentError)}`);
      }
    }
    const failedStatus = await publishDescriptionStatus(options, "failed", report);
    if (failedStatus === "updated") report("Pull request status set to failed.");
    if (failedStatus === "unchanged") {
      report("Skipped a stale failed-status update for another head.");
    }
    throw error;
  }
}
