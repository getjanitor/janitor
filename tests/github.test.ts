import { describe, expect, it, vi } from "vitest";
import { GitHubReviewClient } from "#/review/github";
import type { PullRequestContext } from "#/review/types";

const context: PullRequestContext = {
  repository: "owner/repo",
  owner: "owner",
  repo: "repo",
  number: 4,
  baseRef: "main",
  baseSha: "base",
  headRef: "feature",
  headSha: "head",
};

function createFakeOctokit() {
  const graphqlRequest = vi.fn();
  const graphql = Object.assign(vi.fn(), {
    defaults: vi.fn(() => graphqlRequest),
  });
  return {
    graphqlRequest,
    octokit: {
      graphql,
      paginate: vi.fn(),
      rest: {
        users: { getAuthenticated: vi.fn() },
        issues: {
          listComments: vi.fn(),
          createComment: vi.fn(),
          updateComment: vi.fn(),
        },
        pulls: { createReviewComment: vi.fn() },
      },
    },
  };
}

function client(fake: ReturnType<typeof createFakeOctokit>) {
  return new GitHubReviewClient({
    token: "token",
    apiUrl: "https://github.example/api/v3",
    graphqlUrl: "https://github.example/api/graphql",
    context,
    octokit: fake.octokit as never,
  });
}

describe("GitHub review client", () => {
  it("uses Octokit pagination for PR conversation comments", async () => {
    const fake = createFakeOctokit();
    fake.octokit.paginate.mockResolvedValue([
      { id: 1, body: "first", user: { login: "bot" } },
      { id: 2, body: null, user: null },
    ]);

    await expect(client(fake).listGeneralComments()).resolves.toEqual([
      { id: 1, body: "first", author: "bot" },
      { id: 2, body: "", author: null },
    ]);
    expect(fake.octokit.paginate).toHaveBeenCalledWith(
      fake.octokit.rest.issues.listComments,
      expect.objectContaining({ issue_number: 4, per_page: 100 }),
    );
  });

  it("paginates GraphQL review threads", async () => {
    const fake = createFakeOctokit();
    fake.graphqlRequest
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "one",
                  isResolved: false,
                  isOutdated: false,
                  path: "a.ts",
                  line: 2,
                  originalLine: 2,
                  comments: {
                    nodes: [{ databaseId: 1, body: "body", author: { login: "bot" } }],
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor" },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "two",
                  isResolved: true,
                  isOutdated: true,
                  path: "b.ts",
                  line: null,
                  originalLine: 9,
                  comments: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });

    const threads = await client(fake).listReviewThreads();
    expect(threads.map((thread) => thread.id)).toEqual(["one", "two"]);
    expect(fake.graphqlRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: "cursor" }),
    );
  });

  it("maps inline, resolution, and general-comment mutations to Octokit", async () => {
    const fake = createFakeOctokit();
    fake.octokit.rest.pulls.createReviewComment.mockResolvedValue({});
    fake.octokit.rest.issues.createComment.mockResolvedValue({});
    fake.octokit.rest.issues.updateComment.mockResolvedValue({});
    fake.graphqlRequest.mockResolvedValue({ resolveReviewThread: { thread: { id: "t" } } });
    const github = client(fake);
    const finding = {
      title: "Issue",
      body: "Impact",
      severity: "high" as const,
      path: "a.ts",
      side: "RIGHT" as const,
      line: 2,
    };

    await github.createInlineComment(finding, "rendered", "head");
    await github.resolveThread("thread");
    await github.createGeneralComment("general");
    await github.updateGeneralComment(8, "updated");

    expect(fake.octokit.rest.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 4, commit_id: "head", side: "RIGHT", line: 2 }),
    );
    expect(fake.graphqlRequest).toHaveBeenCalledWith(
      expect.stringContaining("resolveReviewThread"),
      { threadId: "thread" },
    );
    expect(fake.octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 4, body: "general" }),
    );
    expect(fake.octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 8, body: "updated" }),
    );
  });

  it("propagates Octokit API errors", async () => {
    const fake = createFakeOctokit();
    fake.octokit.paginate.mockRejectedValue(new Error("GitHub unavailable"));
    await expect(client(fake).listGeneralComments()).rejects.toThrow("GitHub unavailable");
  });
});
