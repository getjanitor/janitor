import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolSuccess } from "#/harness/tools/github/result";
import type { ReviewAgentInput } from "#/review/types";

export function createGetReviewDiffTool(input: ReviewAgentInput) {
  return defineTool({
    name: "get_review_diff",
    label: "Get review diff",
    description:
      "List changed files or retrieve the base-to-head unified diff for one changed file. This tool is read-only.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Exact changed path. Omit to list all changed files." }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (params.path === undefined) {
        return toolSuccess(
          input.diff.files
            .map(
              (file) =>
                `${file.status}\t${file.previousPath ? `${file.previousPath} -> ` : ""}${file.path}`,
            )
            .join("\n"),
        );
      }

      const file = input.diff.files.find((candidate) => candidate.path === params.path);
      if (file === undefined) {
        throw new Error(`Path is not in the pull-request diff: ${params.path}`);
      }
      return toolSuccess(file.patch);
    },
  });
}
