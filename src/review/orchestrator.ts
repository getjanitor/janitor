import { loadReviewConfig, shouldReviewBranch, shouldRunReview } from "#/review/config";
import { collectReviewDiff, isCommentableLocation } from "#/review/git";
import {
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  renderFindingComment,
  renderGeneralComment,
  renderGeneralCommentStatus,
  renderOutsideDiffFindings,
  type GeneralCommentFinding,
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

const REVIEW_STEPS = {
  initialization: [1, "Initialization"],
  context: [2, "Context gathering"],
  review: [3, "Reviewing"],
  publish: [4, "Posting feedback"],
} as const;

type ReviewStep = keyof typeof REVIEW_STEPS;

function formatReviewStep(step: ReviewStep, detail: string): string {
  const [index, label] = REVIEW_STEPS[step];
  return `[${index}/${Object.keys(REVIEW_STEPS).length}] ${label}: ${detail}`;
}

export interface ExecuteReviewOptions {
  cwd: string;
  context: PullRequestContext;
  git: GitCommandBoundary;
  github: GitHubReviewBoundary;
  agent: ReviewAgentBoundary;
  configLoader?: typeof loadReviewConfig;
  // Detailed progress, shown only in verbose mode.
  report?: (message: string) => void;
  // High-level review phases, shown unless explicitly silenced.
  step?: (message: string) => void;
}

export interface ExecuteReviewResult {
  skipped: boolean;
  /** Why the agent review was skipped; set only when `skipped` is true. */
  skipReason?: string;
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
  const emitStep = options.step ?? (() => undefined);
  let currentStep: ReviewStep = "initialization";
  const step = (name: ReviewStep, detail: string) => {
    currentStep = name;
    emitStep(formatReviewStep(name, detail));
  };
  let generalCommentId: number | undefined;
  let trackSpend = false;
  let spendHistory: ReviewSpendEntry[] = [];
  let agentInvoked = false;
  const usage = createReviewUsageAccumulator();

  try {
    step(
      "initialization",
      `starting Janitor review for pull request #${options.context.number} and loading janitor.toml.`,
    );
    const config = await (options.configLoader ?? loadReviewConfig)(options.cwd);
    trackSpend = config.trackSpend;
    if (!shouldReviewBranch(options.context.headRef, config)) {
      const skipReason = `branch ${options.context.headRef} is not selected by review.included_branches/excluded_branches.`;
      report(`Skipping agent review: ${skipReason}`);
      return { skipped: true, skipReason, newFindings: 0, stillOpen: 0, fixed: 0 };
    }

    step("context", "collecting the pull request diff.");
    const diff = await collectReviewDiff(options.cwd, options.context, options.git);
    report(`Collected ${diff.files.length} changed file(s).`);
    if (diff.files.length === 0 || !shouldRunReview(diff.files, config.trackedPaths)) {
      const skipReason = "no changed path matched review.tracked_paths.";
      report(`Skipping agent review: ${skipReason}`);
      return { skipped: true, skipReason, newFindings: 0, stillOpen: 0, fixed: 0 };
    }

    step("context", "loading previous Janitor feedback from GitHub.");
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

    step("review", "running the coding review agent.");
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
      listed: readonly GeneralCommentFinding[],
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
              listed,
              {
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
    // folded after a 422, every fixed thread left unresolved, and no comment
    // links. The count-only section grows only with the number of digits, so
    // the final render is then guaranteed to fit at some detail level.
    renderGeneralBody(modelResult.findings, modelResult.findings, fixed.length, ["count"]);

    step("publish", "publishing validated review feedback to GitHub.");
    const commentUrls = new Map<NewFinding, string | undefined>();
    for (const finding of inlineFindings) {
      try {
        commentUrls.set(
          finding,
          await options.github.createInlineComment(
            finding,
            renderFindingComment(finding),
            options.context.headSha,
          ),
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
    const linkedFindings = modelResult.findings.map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      url: commentUrls.get(finding),
    }));
    let general: ReturnType<typeof renderGeneralBody>;
    try {
      general = renderGeneralBody(linkedFindings, outsideDiffFindings, unresolvedFixed);
    } catch {
      // Comment links are a convenience; drop them before dropping the review.
      general = renderGeneralBody(modelResult.findings, outsideDiffFindings, unresolvedFixed);
    }
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

    return {
      skipped: false,
      newFindings: modelResult.findings.length,
      stillOpen: stillOpen.length,
      fixed: fixed.length,
    };
  } catch (error) {
    emitStep(
      `Janitor review failed during ${REVIEW_STEPS[currentStep][1].toLowerCase()}: ${errorMessage(error)}`,
    );
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
    throw error;
  }
}
