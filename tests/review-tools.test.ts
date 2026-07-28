import { describe, expect, it } from "vitest";
import { createReviewTools } from "#/harness/tools/github/index";
import type { ModelReviewResult, ReviewAgentInput } from "#/review/types";

const input: ReviewAgentInput = {
  reviewType: "code",
  cwd: "/repo",
  context: {
    repository: "owner/repo",
    owner: "owner",
    repo: "repo",
    number: 1,
    baseRef: "main",
    baseSha: "base",
    headRef: "feature",
    headSha: "head",
  },
  diff: {
    mergeBase: "merge",
    headSha: "head",
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-old\n+new",
        commentableLines: { left: new Set([1]), right: new Set([1]) },
      },
    ],
  },
  previousFindings: [],
};

async function execute(
  tools: ReturnType<typeof createReviewTools>["tools"],
  name: string,
  params: unknown,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing tool ${name}`);
  return tool.execute("call", params as never, undefined, undefined, undefined as never);
}

describe("review agent tools", () => {
  it("exposes the diff read-only and records structured model output", async () => {
    const output: ModelReviewResult = { findings: [], dispositions: [], general: undefined };
    const { tools } = createReviewTools(input, output);

    const diffResult = await execute(tools, "get_review_diff", { path: "src/a.ts" });
    expect(diffResult.content).toEqual([{ type: "text", text: "@@ -1 +1 @@\n-old\n+new" }]);

    await execute(tools, "report_finding", {
      reviewType: "security",
      title: "Issue",
      body: "Impact",
      severity: "high",
      path: "src/a.ts",
      side: "RIGHT",
      line: 1,
    });
    await execute(tools, "disposition_existing_finding", {
      threadId: "thread",
      status: "fixed",
      reason: "Removed",
    });
    await execute(tools, "submit_review", {
      summary: "Summary",
      mermaid: "flowchart LR\nA --> B",
      confidence: 4,
      confidenceReason: "Inspected all callers",
    });

    expect(output.findings).toMatchObject([{ reviewType: "code", title: "Issue" }]);
    expect(output.dispositions).toEqual([
      { threadId: "thread", status: "fixed", reason: "Removed" },
    ]);
    expect(output.general).toMatchObject({ confidence: 4 });
  });

  it("rejects unknown diff paths and duplicate final submissions", async () => {
    const output: ModelReviewResult = { findings: [], dispositions: [], general: undefined };
    const { tools } = createReviewTools(input, output);
    await expect(execute(tools, "get_review_diff", { path: "other.ts" })).rejects.toThrow(
      /not in the pull-request diff/u,
    );
    const general = {
      summary: "Summary",
      mermaid: "flowchart LR\nA --> B",
      confidence: 4,
      confidenceReason: "Reason",
    };
    await execute(tools, "submit_review", general);
    await expect(execute(tools, "submit_review", general)).rejects.toThrow(/only be called once/u);
  });
});
