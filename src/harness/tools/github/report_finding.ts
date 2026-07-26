import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolSuccess } from "#/harness/tools/github/result";
import type { ModelReviewResult, NewFinding } from "#/review/types";

export function createReportFindingTool(output: ModelReviewResult) {
  return defineTool({
    name: "report_finding",
    label: "Report finding",
    description:
      "Report one new actionable review finding anchored to an exact changed line. Do not use this for an existing Janitor thread.",
    parameters: Type.Object({
      title: Type.String({ description: "Concise root-cause title" }),
      body: Type.String({ description: "Why this is a problem and how to address it" }),
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
      output.findings.push(params as NewFinding);
      return toolSuccess("Finding recorded for validation after the review.");
    },
  });
}
