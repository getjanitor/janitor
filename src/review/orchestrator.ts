import { Cause, Effect } from "effect";
import { shouldReviewBranch, shouldRunReview, type ReviewConfig } from "#/review/config";
import {
  CommentTooLarge,
  errorMessage,
  ModelOutputInvalid,
  type ReviewError,
} from "#/review/errors";
import { collectReviewDiff, isCommentableLocation } from "#/review/git";
import {
  findJanitorGeneralComment,
  findOpenJanitorFindings,
  findResolvedJanitorDiscussions,
  renderFindingComment,
  renderGeneralComment,
  renderGeneralCommentStatus,
  renderOutsideDiffFindings,
  type GeneralCommentFinding,
} from "#/review/markers";
import { modelTextProblem } from "#/review/model_result";
import {
  GitCommand,
  GitHubReview,
  PullRequest,
  ReviewAgent,
  ReviewConfigLoader,
  ReviewReporter,
} from "#/review/services";
import {
  appendSpendEntry,
  completedSpendEntry,
  createReviewUsageAccumulator,
  parseSpendHistory,
  trimSpendHistoryToFit,
  type ReviewUsageAccumulator,
} from "#/review/spend";
import type {
  ExistingFinding,
  ExistingGeneralComment,
  ExistingFindingDisposition,
  GeneralReview,
  ModelReviewResult,
  NewFinding,
  PullRequestContext,
  ResolvedFindingDiscussion,
  ReviewDiff,
  ReviewSpendEntry,
  ThinkingLevel,
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
}

export interface ExecuteReviewResult {
  skipped: boolean;
  /** Why the agent review was skipped; set only when `skipped` is true. */
  skipReason?: string;
  newFindings: number;
  stillOpen: number;
  fixed: number;
  dismissed: number;
}

/** Everything `executeReview` needs; a hosted mode supplies its own layers for these. */
export type ReviewServices =
  | GitCommand
  | GitHubReview
  | ReviewAgent
  | ReviewConfigLoader
  | PullRequest
  | ReviewReporter;

type OutsideDiffDetail = Parameters<typeof renderOutsideDiffFindings>[1];

interface ValidatedModelResult extends ModelReviewResult {
  general: GeneralReview;
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  return errorMessage(Cause.squash(cause));
}

function skippedResult(skipReason: string): ExecuteReviewResult {
  return { skipped: true, skipReason, newFindings: 0, stillOpen: 0, fixed: 0, dismissed: 0 };
}

/**
 * Names the step a failure happened in. Steps run one after another, so exactly one
 * of these handlers fires for a failure, before any outer cleanup handler.
 */
function withinStep(step: ReviewStep) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | ReviewReporter> =>
    Effect.onError(effect, (cause) =>
      ReviewReporter.use((reporter) =>
        reporter.step(
          `Janitor review failed during ${REVIEW_STEPS[step][1].toLowerCase()}: ${causeMessage(cause)}`,
        ),
      ),
    );
}

function findModelResultProblem(
  result: ModelReviewResult,
  previous: readonly ExistingFinding[],
): string | undefined {
  if (result.general === undefined) {
    return "Model review did not submit a general result";
  }
  const generalProblem =
    modelTextProblem(result.general.summary, "summary") ??
    modelTextProblem(result.general.mermaid, "Mermaid diagram") ??
    modelTextProblem(result.general.confidenceReason, "confidence reason");
  if (generalProblem !== undefined) return generalProblem;
  if (
    !Number.isInteger(result.general.confidence) ||
    result.general.confidence < 1 ||
    result.general.confidence > 5
  ) {
    return "Model review confidence must be an integer from 1 to 5";
  }
  if (!/^(?:flowchart|graph)\b/u.test(result.general.mermaid.trim())) {
    return 'Model review Mermaid diagram must begin with "flowchart" or "graph"';
  }
  if (result.general.mermaid.includes("```")) {
    return "Model review Mermaid diagram must not contain Markdown fences";
  }

  const expectedThreadIds = new Set(previous.map((finding) => finding.threadId));
  const dispositionIds = new Set<string>();
  for (const disposition of result.dispositions) {
    if (!expectedThreadIds.has(disposition.threadId)) {
      return `Model review returned unknown thread ${disposition.threadId}`;
    }
    if (dispositionIds.has(disposition.threadId)) {
      return `Model review returned duplicate disposition for ${disposition.threadId}`;
    }
    dispositionIds.add(disposition.threadId);
    if (disposition.status !== "still_present") {
      const problem = modelTextProblem(
        disposition.reason,
        `${disposition.status} reason for ${disposition.threadId}`,
      );
      if (problem !== undefined) return problem;
    }
  }
  const missing = [...expectedThreadIds].filter((threadId) => !dispositionIds.has(threadId));
  if (missing.length > 0) {
    return `Model review omitted dispositions for: ${missing.join(", ")}`;
  }

  const findingKeys = new Set<string>();
  for (const finding of result.findings) {
    const problem =
      modelTextProblem(finding.title, "finding title") ??
      modelTextProblem(finding.body, "finding body");
    if (problem !== undefined) return problem;
    if (!["critical", "high", "medium", "low"].includes(finding.severity)) {
      return `Model review returned invalid severity ${finding.severity}`;
    }
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      return `Model review returned invalid line ${finding.line}`;
    }
    const key = `${finding.path}\0${finding.side}\0${finding.line}\0${finding.title.trim().toLowerCase()}`;
    if (findingKeys.has(key)) {
      return `Model review returned a duplicate finding at ${finding.path}:${finding.line}`;
    }
    findingKeys.add(key);
    if (renderFindingComment(finding).length > GITHUB_COMMENT_LIMIT) {
      return `Model finding at ${finding.path}:${finding.line} exceeds GitHub's limit`;
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
      return `Model review duplicated still-open thread ${existing.threadId} at ${existing.path}:${existing.line}`;
    }
  }
  return undefined;
}

const initialize = Effect.fn("janitor.review.initialize")(function* (
  cwd: string,
  context: PullRequestContext,
) {
  const reporter = yield* ReviewReporter;
  const loader = yield* ReviewConfigLoader;
  yield* reporter.step(
    formatReviewStep(
      "initialization",
      `starting Janitor review for pull request #${context.number} and loading janitor.toml.`,
    ),
  );
  const config = yield* loader.load(cwd);
  yield* Effect.annotateCurrentSpan({
    "janitor.config.track_spend": config.trackSpend,
    "janitor.config.tracked_paths": config.trackedPaths.length,
    "janitor.config.thinking_level": config.thinkingLevel ?? "default",
  });
  return config;
});

const collectDiff = Effect.fn("janitor.review.collect_diff")(function* (
  cwd: string,
  context: PullRequestContext,
) {
  const reporter = yield* ReviewReporter;
  const git = yield* GitCommand;
  yield* reporter.step(formatReviewStep("context", "collecting the pull request diff."));
  const diff = yield* collectReviewDiff(cwd, context, git);
  yield* Effect.annotateCurrentSpan({
    "janitor.diff.merge_base": diff.mergeBase,
    "janitor.diff.files": diff.files.length,
  });
  yield* reporter.detail(`Collected ${diff.files.length} changed file(s).`);
  return diff;
});

interface PreviousFeedback {
  generalComment: ExistingGeneralComment | undefined;
  spendHistory: ReviewSpendEntry[];
  previousFindings: ExistingFinding[];
  resolvedDiscussions: ResolvedFindingDiscussion[];
}

const loadPreviousFeedback = Effect.fn("janitor.review.load_previous_feedback")(function* (
  trackSpend: boolean,
) {
  const reporter = yield* ReviewReporter;
  const github = yield* GitHubReview;
  yield* reporter.step(
    formatReviewStep("context", "loading previous Janitor feedback from GitHub."),
  );
  const [comments, threads] = yield* Effect.all(
    [github.listGeneralComments(), github.listReviewThreads()],
    { concurrency: 2 },
  );
  const generalComment = findJanitorGeneralComment(comments);
  const previousFindings = findOpenJanitorFindings(threads);
  const resolvedDiscussions = findResolvedJanitorDiscussions(threads);
  const replyCount = previousFindings.reduce((total, finding) => total + finding.replies.length, 0);
  yield* Effect.annotateCurrentSpan({
    "janitor.feedback.general_comment": generalComment?.id ?? "none",
    "janitor.feedback.open_findings": previousFindings.length,
    "janitor.feedback.replies": replyCount,
    "janitor.feedback.resolved_discussions": resolvedDiscussions.length,
  });
  yield* reporter.detail(
    `Loaded ${previousFindings.length} unresolved Janitor finding(s) with ${replyCount} reply(ies) and ${resolvedDiscussions.length} resolved discussed finding(s).`,
  );
  const feedback: PreviousFeedback = {
    generalComment,
    spendHistory:
      trackSpend && generalComment !== undefined ? parseSpendHistory(generalComment.body) : [],
    previousFindings,
    resolvedDiscussions,
  };
  return feedback;
});

const setCommentRunning = Effect.fn("janitor.review.set_comment_running")(function* (
  generalComment: ExistingGeneralComment | undefined,
  spendHistory: readonly ReviewSpendEntry[] | undefined,
) {
  const reporter = yield* ReviewReporter;
  const github = yield* GitHubReview;
  const body = renderGeneralCommentStatus("running", spendHistory);
  let commentId: number;
  if (generalComment === undefined) {
    commentId = yield* github.createGeneralComment(body);
  } else {
    commentId = generalComment.id;
    yield* github.updateGeneralComment(commentId, body);
  }
  yield* Effect.annotateCurrentSpan({
    "janitor.comment.id": commentId,
    "janitor.comment.created": generalComment === undefined,
  });
  yield* reporter.detail("General review comment set to running.");
  return commentId;
});

/**
 * Best effort: a failure here is reported but never replaces the review's own failure.
 * Spend is appended only when the agent ran, so `usage` is set exactly then.
 */
function markCommentFailed(
  commentId: number,
  context: PullRequestContext,
  trackSpend: boolean,
  spendHistory: readonly ReviewSpendEntry[],
  usage: ReviewUsageAccumulator | undefined,
): Effect.Effect<void, never, GitHubReview | ReviewReporter> {
  return Effect.gen(function* () {
    const reporter = yield* ReviewReporter;
    const github = yield* GitHubReview;
    const history =
      trackSpend && usage !== undefined
        ? appendSpendEntry(
            spendHistory,
            completedSpendEntry(context.headSha, "failed", usage.snapshot()),
          )
        : spendHistory;
    const { body } = trimSpendHistoryToFit(
      trackSpend ? history : [],
      (retained) => renderGeneralCommentStatus("failed", trackSpend ? retained : undefined),
      GITHUB_COMMENT_LIMIT,
    );
    yield* github.updateGeneralComment(commentId, body).pipe(
      Effect.andThen(reporter.detail("General review comment set to failed.")),
      Effect.catchCause((cause) =>
        reporter.detail(
          `Unable to update the failed general review comment: ${causeMessage(cause)}`,
        ),
      ),
    );
  }).pipe(
    Effect.withSpan("janitor.review.mark_comment_failed", {
      attributes: { "janitor.comment.id": commentId },
    }),
  );
}

const runAgent = Effect.fn("janitor.review.run_agent")(function* (
  cwd: string,
  context: PullRequestContext,
  diff: ReviewDiff,
  feedback: PreviousFeedback,
  usage: ReviewUsageAccumulator | undefined,
  thinkingLevel: ThinkingLevel | undefined,
) {
  const reporter = yield* ReviewReporter;
  const agent = yield* ReviewAgent;
  yield* reporter.step(formatReviewStep("review", "running the coding review agent."));
  const result = yield* agent.run(
    {
      cwd,
      thinkingLevel,
      context,
      diff,
      previousFindings: feedback.previousFindings,
      resolvedDiscussions: feedback.resolvedDiscussions,
    },
    usage?.report,
  );
  yield* Effect.annotateCurrentSpan({
    "janitor.agent.findings": result.findings.length,
    "janitor.agent.dispositions": result.dispositions.length,
  });
  yield* reporter.detail("Coding review agent finished; validating its output.");
  return result;
});

const validateModelResult = Effect.fn("janitor.review.validate")(function* (
  result: ModelReviewResult,
  previous: readonly ExistingFinding[],
) {
  const reporter = yield* ReviewReporter;
  const problem = findModelResultProblem(result, previous);
  if (problem !== undefined) {
    yield* Effect.annotateCurrentSpan("janitor.validation.problem", problem);
    return yield* new ModelOutputInvalid({ reason: problem });
  }
  yield* reporter.detail("Agent output validated successfully.");
  return result as ValidatedModelResult;
});

interface DispositionGroups {
  fixed: ExistingFindingDisposition[];
  dismissed: ExistingFindingDisposition[];
  stillOpen: ExistingFindingDisposition[];
}

interface UnresolvedCounts {
  fixed: number;
  dismissed: number;
}

/** Renders the general comment at the most detailed level that fits GitHub's limit. */
function generalCommentRenderer(
  general: GeneralReview,
  groups: DispositionGroups,
  spendHistory: readonly ReviewSpendEntry[],
  trackSpend: boolean,
) {
  return (
    listed: readonly GeneralCommentFinding[],
    outsideDiff: readonly NewFinding[],
    unresolved: UnresolvedCounts,
    details: readonly OutsideDiffDetail[] = ["full", "compact", "count"],
  ): Effect.Effect<{ body: string; detail: OutsideDiffDetail }, CommentTooLarge> => {
    for (const detail of details) {
      const { body } = trimSpendHistoryToFit(
        spendHistory,
        (retained) =>
          renderGeneralComment(
            general,
            listed,
            {
              stillOpen: groups.stillOpen.length,
              fixed: groups.fixed.length - unresolved.fixed,
              dismissed: groups.dismissed.length - unresolved.dismissed,
              unresolvedFixed: unresolved.fixed,
              unresolvedDismissed: unresolved.dismissed,
            },
            trackSpend ? retained : undefined,
            renderOutsideDiffFindings(outsideDiff, detail),
          ),
        GITHUB_COMMENT_LIMIT,
      );
      if (body.length <= GITHUB_COMMENT_LIMIT) return Effect.succeed({ body, detail });
    }
    return Effect.fail(new CommentTooLarge({ limit: GITHUB_COMMENT_LIMIT }));
  };
}

const publishInlineComments = Effect.fn("janitor.review.publish_inline_comments")(function* (
  findings: readonly NewFinding[],
  headSha: string,
) {
  const reporter = yield* ReviewReporter;
  const github = yield* GitHubReview;
  yield* reporter.step(
    formatReviewStep("publish", "publishing validated review feedback to GitHub."),
  );
  const commentUrls = new Map<NewFinding, string | undefined>();
  const rejected: NewFinding[] = [];
  for (const finding of findings) {
    yield* github.createInlineComment(finding, renderFindingComment(finding), headSha).pipe(
      Effect.tap((url) => Effect.sync(() => commentUrls.set(finding, url))),
      // GitHub answers 422 when an inline comment's line cannot be resolved against
      // its own view of the pull-request diff, even if the local diff accepted it.
      Effect.catchTag("GitHubError", (error) =>
        error.status === 422
          ? Effect.annotateCurrentSpan("janitor.inline.rejected", true).pipe(
              Effect.andThen(
                reporter.detail(
                  `GitHub rejected the inline location ${finding.path}:${finding.line} (${finding.side}): ${error.message}; it will be included in the general comment.`,
                ),
              ),
              Effect.andThen(Effect.sync(() => rejected.push(finding))),
            )
          : Effect.fail(error),
      ),
      Effect.withSpan("janitor.review.publish_inline_comment", {
        attributes: {
          "janitor.finding.path": finding.path,
          "janitor.finding.line": finding.line,
          "janitor.finding.side": finding.side,
          "janitor.finding.severity": finding.severity,
        },
      }),
    );
  }
  yield* Effect.annotateCurrentSpan({
    "janitor.inline.posted": commentUrls.size,
    "janitor.inline.rejected": rejected.length,
  });
  return { commentUrls, rejected };
});

const resolveThreads = Effect.fn("janitor.review.resolve_threads")(function* (
  dispositions: readonly ExistingFindingDisposition[],
) {
  const reporter = yield* ReviewReporter;
  const github = yield* GitHubReview;
  const unresolved: UnresolvedCounts = { fixed: 0, dismissed: 0 };
  for (const disposition of dispositions) {
    if (disposition.status === "still_present") continue;
    const status = disposition.status;
    // A thread GitHub refuses to resolve (e.g. a token without permission)
    // stays open; it must not discard the rest of an otherwise complete review.
    yield* github.resolveThread(disposition.threadId).pipe(
      Effect.catchTag("GitHubError", (error) => {
        unresolved[status]++;
        return reporter.detail(
          `Unable to resolve ${status} thread ${disposition.threadId}: ${error.message}; it was left open.`,
        );
      }),
    );
  }
  yield* Effect.annotateCurrentSpan({
    "janitor.threads.resolved": dispositions.length - unresolved.fixed - unresolved.dismissed,
    "janitor.threads.unresolved": unresolved.fixed + unresolved.dismissed,
  });
  return unresolved;
});

const updateGeneralComment = Effect.fn("janitor.review.update_general_comment")(function* (
  commentId: number,
  render: ReturnType<typeof generalCommentRenderer>,
  findings: readonly NewFinding[],
  commentUrls: ReadonlyMap<NewFinding, string | undefined>,
  outsideDiffFindings: readonly NewFinding[],
  unresolved: UnresolvedCounts,
) {
  const reporter = yield* ReviewReporter;
  const github = yield* GitHubReview;
  const linkedFindings = findings.map((finding) => ({
    title: finding.title,
    severity: finding.severity,
    url: commentUrls.get(finding),
  }));
  const general = yield* render(linkedFindings, outsideDiffFindings, unresolved).pipe(
    // Comment links are a convenience; drop them before dropping the review.
    Effect.catchTag("CommentTooLarge", () => render(findings, outsideDiffFindings, unresolved)),
  );
  yield* Effect.annotateCurrentSpan({
    "janitor.comment.id": commentId,
    "janitor.comment.length": general.body.length,
    "janitor.comment.outside_diff_detail": general.detail,
  });
  if (general.detail === "count") {
    for (const finding of outsideDiffFindings) {
      yield* reporter.detail(
        `Finding outside the diff omitted from the general comment: ${finding.severity.toUpperCase()}: ${finding.title} at ${finding.path}:${finding.line} (${finding.side})`,
      );
    }
  }
  yield* github.updateGeneralComment(commentId, general.body);
  yield* reporter.detail("Review feedback published to GitHub.");
});

/** Runs the agent and publishes its review; every failure here happens after the agent started. */
const reviewAndPublish = Effect.fnUntraced(function* (
  cwd: string,
  context: PullRequestContext,
  config: ReviewConfig,
  diff: ReviewDiff,
  feedback: PreviousFeedback,
  commentId: number,
  usage: ReviewUsageAccumulator,
) {
  const reporter = yield* ReviewReporter;
  const trackSpend = config.trackSpend;
  const modelResult = yield* runAgent(
    cwd,
    context,
    diff,
    feedback,
    trackSpend ? usage : undefined,
    config.thinkingLevel,
  ).pipe(withinStep("review"));
  const validated = yield* validateModelResult(modelResult, feedback.previousFindings).pipe(
    withinStep("review"),
  );

  const inlineFindings: NewFinding[] = [];
  const outsideDiffFindings: NewFinding[] = [];
  for (const finding of validated.findings) {
    if (isCommentableLocation(diff, finding.path, finding.side, finding.line)) {
      inlineFindings.push(finding);
    } else {
      yield* reporter.detail(
        `Finding at ${finding.path}:${finding.line} (${finding.side}) is outside the diff; it will be included in the general comment.`,
      );
      outsideDiffFindings.push(finding);
    }
  }

  const groups: DispositionGroups = {
    fixed: validated.dispositions.filter((disposition) => disposition.status === "fixed"),
    dismissed: validated.dispositions.filter((disposition) => disposition.status === "dismissed"),
    stillOpen: validated.dispositions.filter(
      (disposition) => disposition.status === "still_present",
    ),
  };
  yield* Effect.annotateCurrentSpan({
    "janitor.findings.new": validated.findings.length,
    "janitor.findings.inline": inlineFindings.length,
    "janitor.findings.outside_diff": outsideDiffFindings.length,
    "janitor.findings.still_open": groups.stillOpen.length,
    "janitor.findings.fixed": groups.fixed.length,
    "janitor.findings.dismissed": groups.dismissed.length,
  });
  const successfulSpendHistory = trackSpend
    ? appendSpendEntry(
        feedback.spendHistory,
        completedSpendEntry(context.headSha, "succeeded", usage.snapshot()),
      )
    : [];
  const render = generalCommentRenderer(
    validated.general,
    groups,
    successfulSpendHistory,
    trackSpend,
  );
  // Fail before any GitHub mutation unless the worst case fits: every finding
  // folded after a 422, every fixed or dismissed thread left unresolved, and no comment
  // links. The count-only section grows only with the number of digits, so
  // the final render is then guaranteed to fit at some detail level.
  yield* render(
    validated.findings,
    validated.findings,
    { fixed: groups.fixed.length, dismissed: groups.dismissed.length },
    ["count"],
  ).pipe(Effect.withSpan("janitor.review.check_comment_size"), withinStep("review"));

  const { commentUrls, rejected } = yield* publishInlineComments(
    inlineFindings,
    context.headSha,
  ).pipe(withinStep("publish"));
  outsideDiffFindings.push(...rejected);
  const unresolved = yield* resolveThreads([...groups.fixed, ...groups.dismissed]).pipe(
    withinStep("publish"),
  );
  yield* updateGeneralComment(
    commentId,
    render,
    validated.findings,
    commentUrls,
    outsideDiffFindings,
    unresolved,
  ).pipe(withinStep("publish"));

  const result: ExecuteReviewResult = {
    skipped: false,
    newFindings: validated.findings.length,
    stillOpen: groups.stillOpen.length,
    fixed: groups.fixed.length,
    dismissed: groups.dismissed.length,
  };
  return result;
});

export const executeReview: (
  options: ExecuteReviewOptions,
) => Effect.Effect<ExecuteReviewResult, ReviewError, ReviewServices> = Effect.fn("janitor.review")(
  function* (options: ExecuteReviewOptions) {
    const context = yield* PullRequest;
    const reporter = yield* ReviewReporter;
    yield* Effect.annotateCurrentSpan({
      "janitor.pr.repository": context.repository,
      "janitor.pr.number": context.number,
      "janitor.pr.head_ref": context.headRef,
      "janitor.pr.head_sha": context.headSha,
    });

    const config = yield* initialize(options.cwd, context).pipe(withinStep("initialization"));
    if (!shouldReviewBranch(context.headRef, config)) {
      const skipReason = `branch ${context.headRef} is not selected by review.included_branches/excluded_branches.`;
      yield* reporter.detail(`Skipping agent review: ${skipReason}`);
      return skippedResult(skipReason);
    }

    const diff = yield* collectDiff(options.cwd, context).pipe(withinStep("context"));
    if (diff.files.length === 0 || !shouldRunReview(diff.files, config.trackedPaths)) {
      const skipReason = "no changed path matched review.tracked_paths.";
      yield* reporter.detail(`Skipping agent review: ${skipReason}`);
      return skippedResult(skipReason);
    }

    const feedback = yield* loadPreviousFeedback(config.trackSpend).pipe(withinStep("context"));
    const markFailed = (commentId: number, usage: ReviewUsageAccumulator | undefined) => () =>
      markCommentFailed(commentId, context, config.trackSpend, feedback.spendHistory, usage);

    const existing = feedback.generalComment;
    const running = setCommentRunning(
      existing,
      config.trackSpend ? feedback.spendHistory : undefined,
    ).pipe(withinStep("context"));
    // An existing comment may already show "running" when that update fails, so it is
    // marked failed too. A comment that could not be created has nothing to update.
    const commentId = yield* existing === undefined
      ? running
      : running.pipe(Effect.onError(markFailed(existing.id, undefined)));

    const usage = createReviewUsageAccumulator();
    return yield* reviewAndPublish(
      options.cwd,
      context,
      config,
      diff,
      feedback,
      commentId,
      usage,
    ).pipe(Effect.onError(markFailed(commentId, usage)));
  },
);
