import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolSuccess } from "#/harness/tools/github/result";
import { isIncrementalLocation } from "#/review/git";
import { requireValidModelText } from "#/review/model_result";
import type { IncrementalReview, ModelReviewResult, NewFinding } from "#/review/types";

export function createReportFindingTool(
  output: ModelReviewResult,
  incremental?: IncrementalReview,
) {
  return defineTool({
    name: "report_finding",
    label: "Report finding",
    description:
      "Report one new actionable review finding anchored to an exact changed line. Do not use this for an existing Janitor thread.",
    parameters: Type.Object({
      title: Type.String({
        description:
          'Concise root-cause title. Describe Janitor markers in words; never reproduce their reserved HTML prefix (escape "<" as "&lt;" if needed).',
      }),
      body: Type.String({
        description:
          'Why this is a problem and how to address it. Describe Janitor markers in words; never reproduce their reserved HTML prefix (escape "<" as "&lt;" if needed).',
      }),
      severity: Type.Union([
        Type.Literal("critical"),
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
      ]),
      path: Type.String({ description: "Exact changed path" }),
      side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
      line: Type.Integer({ minimum: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      requireValidModelText(params.title, "finding title");
      requireValidModelText(params.body, "finding body");
      if (
        incremental !== undefined &&
        !isIncrementalLocation(incremental, params.path, params.side, params.line)
      ) {
        throw new Error(
          `${params.path}:${params.line} (${params.side}) was not changed since the last reviewed commit ${incremental.previous.headSha}. Anchor the finding to a line changed since then, or drop it if the issue is only in previously reviewed code.`,
        );
      }
      output.findings.push(params as NewFinding);
      return toolSuccess("Finding recorded for validation after the review.");
    },
  });
}
