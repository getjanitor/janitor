import {
  filterReviewDiff,
  findingPathMatchesReviewPaths,
  loadReviewConfig,
  type DisabledFindingsPolicy,
} from "#/review/config";
import { collectReviewDiff, isCommentableLocation } from "#/review/git";
import {
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  renderFindingComment,
  renderGeneralComment,
} from "#/review/markers";
import {
  REVIEW_TYPES,
  type ExistingFinding,
  type GitCommandBoundary,
  type GitHubReviewBoundary,
  type ModelReviewResult,
  type PullRequestContext,
  type ReviewAgentBoundary,
  type ReviewDiff,
  type ReviewType,
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

export interface ReviewTypeExecutionResult {
  skipped: boolean;
  newFindings: number;
  stillOpen: number;
  fixed: number;
  configurationResolved: number;
  leftOpen: number;
}

export interface ExecuteReviewResult {
  skipped: boolean;
  code: ReviewTypeExecutionResult;
  security: ReviewTypeExecutionResult;
}

export interface PreviousFindingPartition {
  reviewable: ExistingFinding[];
  configurationResolved: ExistingFinding[];
  leftOpen: ExistingFinding[];
}

export function partitionPreviousFindings(
  previousFindings: ExistingFinding[],
  reviewType: ReviewType,
  diff: ReviewDiff,
  paths: string[],
  policy: DisabledFindingsPolicy,
): PreviousFindingPartition {
  const partition: PreviousFindingPartition = {
    reviewable: [],
    configurationResolved: [],
    leftOpen: [],
  };
  for (const finding of previousFindings) {
    if (finding.reviewType !== reviewType) continue;
    if (findingPathMatchesReviewPaths(finding.path, diff, paths)) {
      partition.reviewable.push(finding);
    } else if (policy === "review") {
      partition.reviewable.push(finding);
    } else if (policy === "resolve") {
      partition.configurationResolved.push(finding);
    } else {
      partition.leftOpen.push(finding);
    }
  }
  return partition;
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
  reviewType: ReviewType,
  result: ModelReviewResult,
  previous: ExistingFinding[],
  diff: ReviewDiff,
): void {
  if (result.general === undefined) {
    throw new Error(`Model ${reviewType} review did not submit a general result`);
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
    if (finding.reviewType !== reviewType) {
      throw new Error(`Model ${reviewType} review returned a ${finding.reviewType} finding`);
    }
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

function emptyTypeResult(): ReviewTypeExecutionResult {
  return {
    skipped: true,
    newFindings: 0,
    stillOpen: 0,
    fixed: 0,
    configurationResolved: 0,
    leftOpen: 0,
  };
}

interface TypeState {
  reviewType: ReviewType;
  diff: ReviewDiff;
  previous: PreviousFindingPartition;
}

interface PreparedRun {
  state: TypeState;
  result: ModelReviewResult;
  fixed: ModelReviewResult["dispositions"];
  stillOpen: ModelReviewResult["dispositions"];
  generalBody: string;
}

export async function executeReview(options: ExecuteReviewOptions): Promise<ExecuteReviewResult> {
  const config = await (options.configLoader ?? loadReviewConfig)(options.cwd);
  const diff = await collectReviewDiff(options.cwd, options.context, options.git);
  const scopedDiffs: Record<ReviewType, ReviewDiff> = {
    code: filterReviewDiff(diff, config.code.paths),
    security: filterReviewDiff(diff, config.security.paths),
  };
  const hasMatchedFiles = REVIEW_TYPES.some(
    (reviewType) => scopedDiffs[reviewType].files.length > 0,
  );
  const needsDisabledFindingLookup = REVIEW_TYPES.some(
    (reviewType) => config[reviewType].disabledFindings !== "leave_open",
  );
  if (!hasMatchedFiles && !needsDisabledFindingLookup) {
    return { skipped: true, code: emptyTypeResult(), security: emptyTypeResult() };
  }

  const [comments, threads] = await Promise.all([
    options.github.listGeneralComments(),
    options.github.listReviewThreads(),
  ]);
  const previousFindings = findOpenJanitorFindings(threads);
  const states = REVIEW_TYPES.map(
    (reviewType): TypeState => ({
      reviewType,
      diff: scopedDiffs[reviewType],
      previous: partitionPreviousFindings(
        previousFindings,
        reviewType,
        diff,
        config[reviewType].paths,
        config[reviewType].disabledFindings,
      ),
    }),
  );
  const runnableStates = states.filter(
    (state) => state.diff.files.length > 0 || state.previous.reviewable.length > 0,
  );

  const modelResults = await Promise.all(
    runnableStates.map((state) =>
      options.agent.run({
        reviewType: state.reviewType,
        cwd: options.cwd,
        context: options.context,
        diff: state.diff,
        previousFindings: state.previous.reviewable,
      }),
    ),
  );
  const preparedRuns = runnableStates.map((state, index): PreparedRun => {
    const result = modelResults[index]!;
    validateModelResult(state.reviewType, result, state.previous.reviewable, state.diff);
    const fixed = result.dispositions.filter((disposition) => disposition.status === "fixed");
    const stillOpen = result.dispositions.filter(
      (disposition) => disposition.status === "still_present",
    );
    const generalBody = renderGeneralComment(state.reviewType, result.general!, {
      newFindings: result.findings.length,
      stillOpen: stillOpen.length,
      fixed: fixed.length,
      configurationResolved: state.previous.configurationResolved.length,
    });
    if (generalBody.length > GITHUB_COMMENT_LIMIT) {
      throw new Error(`General ${state.reviewType} review exceeds GitHub's comment size limit`);
    }
    return { state, result, fixed, stillOpen, generalBody };
  });

  for (const run of preparedRuns) {
    for (const finding of run.result.findings) {
      await options.github.createInlineComment(
        finding,
        renderFindingComment(finding),
        options.context.headSha,
      );
    }
  }
  for (const run of preparedRuns) {
    for (const disposition of run.fixed) {
      await options.github.resolveThread(disposition.threadId);
    }
  }
  for (const state of states) {
    for (const finding of state.previous.configurationResolved) {
      await options.github.resolveThread(finding.threadId);
    }
  }
  for (const run of preparedRuns) {
    const generalComment = findJanitorGeneralComment(comments, run.state.reviewType);
    if (generalComment === undefined) {
      await options.github.createGeneralComment(run.generalBody);
    } else {
      await options.github.updateGeneralComment(generalComment.id, run.generalBody);
    }
  }

  const typeResults = Object.fromEntries(
    states.map((state) => {
      const run = preparedRuns.find((candidate) => candidate.state.reviewType === state.reviewType);
      const configurationResolved = state.previous.configurationResolved.length;
      return [
        state.reviewType,
        {
          skipped: run === undefined && configurationResolved === 0,
          newFindings: run?.result.findings.length ?? 0,
          stillOpen: run?.stillOpen.length ?? 0,
          fixed: run?.fixed.length ?? 0,
          configurationResolved,
          leftOpen: state.previous.leftOpen.length,
        } satisfies ReviewTypeExecutionResult,
      ];
    }),
  ) as Record<ReviewType, ReviewTypeExecutionResult>;
  return {
    skipped: typeResults.code.skipped && typeResults.security.skipped,
    code: typeResults.code,
    security: typeResults.security,
  };
}
