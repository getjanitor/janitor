import { describe, expect, it } from "vitest";
import { createReviewTools } from "#/harness/tools/github/index";
import { FINDING_MARKER, GENERAL_REVIEW_MARKER } from "#/review/markers";
import type { ModelReviewResult, ReviewAgentInput } from "#/review/types";

const input: ReviewAgentInput = {
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
  resolvedDiscussions: [],
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

    expect(output.findings).toHaveLength(1);
    expect(output.dispositions).toEqual([
      { threadId: "thread", status: "fixed", reason: "Removed" },
    ]);
    expect(output.general).toMatchObject({ confidence: 4 });
  });

  it("records dismissed findings only with a reason", async () => {
    const output: ModelReviewResult = { findings: [], dispositions: [], general: undefined };
    const { tools } = createReviewTools(input, output);
    await expect(
      execute(tools, "disposition_existing_finding", { threadId: "thread", status: "dismissed" }),
    ).rejects.toThrow(/dismissed disposition requires a reason/u);
    await execute(tools, "disposition_existing_finding", {
      threadId: "thread",
      status: "dismissed",
      reason: "The caller already validates the input.",
    });
    expect(output.dispositions).toEqual([
      {
        threadId: "thread",
        status: "dismissed",
        reason: "The caller already validates the input.",
      },
    ]);
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

  it("rejects reserved markers without mutation and records corrected retries", async () => {
    const output: ModelReviewResult = { findings: [], dispositions: [], general: undefined };
    const { tools } = createReviewTools(input, output);
    const marker = FINDING_MARKER;

    const unsafeFinding = {
      title: "Marker parsing is too broad",
      body: `The parser accepts ${marker} in model-authored text.`,
      severity: "high",
      path: "src/a.ts",
      side: "RIGHT",
      line: 1,
    };
    await expect(execute(tools, "report_finding", unsafeFinding)).rejects.toThrow(
      /reserved Janitor marker.*escape/u,
    );
    expect(output.findings).toEqual([]);
    await execute(tools, "report_finding", {
      ...unsafeFinding,
      body: "The parser accepts &lt;!-- janitor:finding:v1 --> in model-authored text.",
    });

    await expect(
      execute(tools, "disposition_existing_finding", {
        threadId: "thread",
        status: "fixed",
        reason: `Removed ${marker}`,
      }),
    ).rejects.toThrow(/reserved Janitor marker.*escape/u);
    expect(output.dispositions).toEqual([]);
    await execute(tools, "disposition_existing_finding", {
      threadId: "thread",
      status: "fixed",
      reason: "Removed the reserved marker handling.",
    });

    const unsafeGeneral = {
      summary: `Updated ${marker}`,
      mermaid: "flowchart LR\nA --> B",
      confidence: 4,
      confidenceReason: "Inspected all callers",
    };
    await expect(execute(tools, "submit_review", unsafeGeneral)).rejects.toThrow(
      /reserved Janitor marker.*escape/u,
    );
    expect(output.general).toBeUndefined();
    await execute(tools, "submit_review", {
      ...unsafeGeneral,
      summary: "Updated the marker handling.",
    });

    expect(output.findings).toMatchObject([
      { body: "The parser accepts &lt;!-- janitor:finding:v1 --> in model-authored text." },
    ]);
    expect(output.dispositions).toEqual([
      { threadId: "thread", status: "fixed", reason: "Removed the reserved marker handling." },
    ]);
    expect(output.general).toMatchObject({ summary: "Updated the marker handling." });
  });

  it("validates every model-authored text field before changing the result", async () => {
    const marker = GENERAL_REVIEW_MARKER;
    const finding = {
      title: "Issue",
      body: "Impact",
      severity: "high",
      path: "src/a.ts",
      side: "RIGHT",
      line: 1,
    };
    const general = {
      summary: "Summary",
      mermaid: "flowchart LR\nA --> B",
      confidence: 4,
      confidenceReason: "Reason",
    };
    const cases = [
      { name: "report_finding", params: { ...finding, title: "   " }, error: /must not be empty/u },
      {
        name: "report_finding",
        params: { ...finding, body: `Impact from ${marker}` },
        error: /reserved Janitor marker/u,
      },
      {
        name: "disposition_existing_finding",
        params: { threadId: "thread", status: "fixed", reason: `Removed ${marker}` },
        error: /reserved Janitor marker/u,
      },
      {
        name: "submit_review",
        params: { ...general, summary: `Summary of ${marker}` },
        error: /reserved Janitor marker/u,
      },
      {
        name: "submit_review",
        params: { ...general, mermaid: `flowchart LR\nA[${marker}] --> B` },
        error: /reserved Janitor marker/u,
      },
      {
        name: "submit_review",
        params: { ...general, confidenceReason: `Checked ${marker}` },
        error: /reserved Janitor marker/u,
      },
    ];

    for (const testCase of cases) {
      const output: ModelReviewResult = { findings: [], dispositions: [], general: undefined };
      const { tools } = createReviewTools(input, output);
      await expect(execute(tools, testCase.name, testCase.params)).rejects.toThrow(testCase.error);
      expect(output).toEqual({ findings: [], dispositions: [], general: undefined });
    }
  });
});
