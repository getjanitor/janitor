import type { MergeCheckConfig } from "#/review/config";
import type { CheckRunState, GeneralReview } from "#/review/types";

/** The check run name branch protection rules require. */
export const MERGE_CHECK_NAME = "Janitor";

export const runningCheck: CheckRunState = {
  title: "Review in progress",
  summary: "Janitor is reviewing this commit.",
};

export function skippedCheck(reason: string): CheckRunState {
  return {
    conclusion: "skipped",
    title: "Review skipped",
    summary: `Janitor skipped review: ${reason}`,
  };
}

export function failedCheck(interrupted: boolean): CheckRunState {
  return interrupted
    ? {
        conclusion: "cancelled",
        title: "Review cancelled",
        summary: "The Janitor review was cancelled before it finished.",
      }
    : {
        conclusion: "failure",
        title: "Review failed",
        summary:
          "The Janitor review failed before it finished, so this commit was not verified. Re-run the workflow to try again.",
      };
}

function confidenceCheck(
  confidence: number,
  config: MergeCheckConfig,
  detail: string,
): CheckRunState {
  const passed = confidence >= config.minConfidence;
  return {
    conclusion: passed ? "success" : "failure",
    title: `Confidence ${confidence}/5 (minimum ${config.minConfidence})`,
    summary: `${
      passed
        ? "The review confidence meets the configured minimum."
        : "The review confidence is below the configured minimum."
    }\n\n${detail}`,
  };
}

/** Passes when the review's confidence reaches the configured minimum. */
export function reviewedCheck(general: GeneralReview, config: MergeCheckConfig): CheckRunState {
  return confidenceCheck(general.confidence, config, general.confidenceReason);
}

/**
 * Applies the last review's confidence to a commit an incremental re-review skipped,
 * so pushing a commit that changes no pull-request file cannot turn a failure into a pass.
 */
export function carriedCheck(
  confidence: number,
  reviewedSha: string,
  config: MergeCheckConfig,
): CheckRunState {
  return confidenceCheck(
    confidence,
    config,
    `No pull-request file changed since the review of ${reviewedSha}, so its confidence still applies.`,
  );
}
