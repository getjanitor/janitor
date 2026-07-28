import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDispositionExistingFindingTool } from "#/harness/tools/github/disposition_existing_finding";
import { createGetReviewDiffTool } from "#/harness/tools/github/get_review_diff";
import { createReportFindingTool } from "#/harness/tools/github/report_finding";
import { createSubmitReviewTool } from "#/harness/tools/github/submit_review";
import type { ModelReviewResult, ReviewAgentInput } from "#/review/types";

export function createReviewTools(
  input: ReviewAgentInput,
  output: ModelReviewResult,
): { names: string[]; tools: ToolDefinition[] } {
  const tools = [
    createGetReviewDiffTool(input),
    createReportFindingTool(input.reviewType, output),
    createDispositionExistingFindingTool(output),
    createSubmitReviewTool(output),
  ];
  return { names: tools.map((tool) => tool.name), tools };
}
