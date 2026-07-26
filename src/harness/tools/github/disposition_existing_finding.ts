import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolSuccess } from "#/harness/tools/github/result";
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
        Type.String({ description: "Required evidence explaining why a fixed issue is fixed" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (
        params.status === "fixed" &&
        (params.reason === undefined || params.reason.trim() === "")
      ) {
        throw new Error("A fixed disposition requires a reason");
      }
      output.dispositions.push(params as ExistingFindingDisposition);
      return toolSuccess("Existing finding disposition recorded.");
    },
  });
}
