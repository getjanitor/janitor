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
      "Record whether one previous unresolved Janitor finding is still present or has been fixed. Every supplied thread must receive exactly one disposition.",
    parameters: Type.Object({
      threadId: Type.String({ description: "Exact previous thread ID from the prompt" }),
      status: Type.Union([Type.Literal("still_present"), Type.Literal("fixed")]),
      reason: Type.Optional(
        Type.String({
          description:
            'Required evidence explaining why a fixed issue is fixed. Describe Janitor markers in words; never reproduce their reserved HTML prefix (escape "<" as "&lt;" if needed).',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (params.status === "fixed") {
        if (params.reason === undefined) {
          throw new Error("A fixed disposition requires a reason");
        }
        requireValidModelText(params.reason, `fixed reason for ${params.threadId}`);
      }
      output.dispositions.push(params as ExistingFindingDisposition);
      return toolSuccess("Existing finding disposition recorded.");
    },
  });
}
