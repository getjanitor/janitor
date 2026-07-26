import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolSuccess } from "#/harness/tools/github/result";
import type { ModelReviewResult } from "#/review/types";

export function createSubmitReviewTool(output: ModelReviewResult) {
  return defineTool({
    name: "submit_review",
    label: "Submit review",
    description:
      "Submit the one final general review after all files and previous findings have been examined.",
    parameters: Type.Object({
      summary: Type.String({ description: "Concise overall assessment in Markdown" }),
      mermaid: Type.String({
        description:
          "Raw Mermaid source, without Markdown fences, mapping the changed code and its uses",
      }),
      confidence: Type.Integer({ minimum: 1, maximum: 5 }),
      confidenceReason: Type.String({
        description: "Specific reason for the confidence score",
      }),
    }),
    execute: async (_toolCallId, params) => {
      if (output.general !== undefined) {
        throw new Error("submit_review may only be called once");
      }
      output.general = params;
      return toolSuccess("Review recorded. End the task without additional tool calls.");
    },
  });
}
