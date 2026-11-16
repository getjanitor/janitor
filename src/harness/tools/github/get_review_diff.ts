import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolSuccess } from "#/harness/tools/github/result";
import type { ReviewAgentInput } from "#/review/types";

export function createGetReviewDiffTool(input: ReviewAgentInput) {
  return defineTool({
    name: "get_review_diff",
    label: "Get review diff",
    description: input.incremental
      ? "List changed files or retrieve the unified diff for one changed file, either base-to-head or, with since_last_review, from the last reviewed commit to head. This tool is read-only."
      : "List changed files or retrieve the base-to-head unified diff for one changed file. This tool is read-only.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Exact changed path. Omit to list all changed files." }),
      ),
      ...(input.incremental
        ? {
            since_last_review: Type.Optional(
              Type.Boolean({
                description:
                  "Only what changed since the last reviewed commit, for the file or the file list.",
              }),
            ),
          }
        : {}),
    }),
    execute: async (_toolCallId, params) => {
      const incremental = input.incremental;
      if ("since_last_review" in params && params.since_last_review === true && incremental) {
        if (params.path === undefined) {
          return toolSuccess(incremental.files.map((file) => file.path).join("\n"));
        }
        const file = incremental.files.find((candidate) => candidate.path === params.path);
        if (file === undefined) {
          return toolSuccess(
            `${params.path} has not changed since the last reviewed commit ${incremental.previous.headSha}.`,
          );
        }
        return toolSuccess(file.patch);
      }
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
