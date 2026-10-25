import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolSuccess } from "#/harness/tools/github/result";
import { requireValidModelText } from "#/review/model_result";
import type { ExistingFindingDisposition, ModelReviewResult } from "#/review/types";

export function createDispositionExistingFindingTool(output: ModelReviewResult) {
  return defineTool({
    name: "disposition_existing_finding",
    label: "Disposition existing finding",
    description:
      "Record whether one previous unresolved Janitor finding is still present, has been fixed, or should be dismissed because its replies show it was wrong. Every supplied thread must receive exactly one disposition.",
    parameters: Type.Object({
      threadId: Type.String({ description: "Exact previous thread ID from the prompt" }),
      status: Type.Union([
        Type.Literal("still_present"),
        Type.Literal("fixed"),
        Type.Literal("dismissed"),
      ]),
      reason: Type.Optional(
        Type.String({
          description:
            'Required evidence explaining why a fixed issue is fixed, or why a dismissed finding was incorrect. Describe Janitor markers in words; never reproduce their reserved HTML prefix (escape "<" as "&lt;" if needed).',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (params.status !== "still_present") {
        if (params.reason === undefined) {
          throw new Error(`A ${params.status} disposition requires a reason`);
        }
        requireValidModelText(params.reason, `${params.status} reason for ${params.threadId}`);
      }
      output.dispositions.push(params as ExistingFindingDisposition);
      return toolSuccess("Existing finding disposition recorded.");
    },
  });
}
