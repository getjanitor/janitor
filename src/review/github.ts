import { Effect } from "effect";
import { Octokit } from "octokit";
import { errorMessage, GitHubError, httpStatus } from "#/review/errors";
import type {
  CheckRunState,
  GitHubReviewBoundary,
  GitHubReviewClientShape,
  NewFinding,
  PullRequestContext,
} from "#/review/types";

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: {
    nodes: Array<{
      databaseId: number | null;
      body: string;
      author: { login: string; __typename: string } | null;
    }>;
  };
}

interface ReviewThreadsQuery {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: ReviewThreadNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  } | null;
}

const reviewThreadsQuery = `
  query JanitorReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            comments(first: 100) {
              nodes {
                databaseId
                body
                author { login __typename }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const resolveThreadMutation = `
  mutation JanitorResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

export interface GitHubClientOptions {
  token: string;
  apiUrl: string;
  graphqlUrl: string;
  context: PullRequestContext;
  octokit?: InstanceType<typeof Octokit>;
}

// GraphQL reports bot logins without the "[bot]" suffix that REST includes
// (e.g. "github-actions" vs "github-actions[bot]"). Normalize to the REST form
// so ownership checks behave the same for review threads and general comments.
function graphqlAuthorLogin(author: { login: string; __typename: string } | null): string | null {
  if (author === null) return null;
  return author.__typename === "Bot" && !author.login.endsWith("[bot]")
    ? `${author.login}[bot]`
    : author.login;
}

function graphqlBaseUrl(graphqlUrl: string): string {
  return graphqlUrl.replace(/\/graphql\/?$/u, "");
}

export class GitHubReviewClient implements GitHubReviewClientShape {
  readonly #octokit: InstanceType<typeof Octokit>;
  readonly #graphql: <T>(query: string, parameters: Record<string, unknown>) => Promise<T>;
  readonly #context: PullRequestContext;

  constructor(options: GitHubClientOptions) {
    this.#octokit =
      options.octokit ??
      new Octokit({
        auth: options.token,
        baseUrl: options.apiUrl,
        userAgent: "janitor-code-review",
      });
    const graphql = this.#octokit.graphql.defaults({
      baseUrl: graphqlBaseUrl(options.graphqlUrl),
    });
    this.#graphql = (query, parameters) => graphql(query, parameters);
    this.#context = options.context;
  }

  async listGeneralComments() {
    const comments = await this.#octokit.paginate(this.#octokit.rest.issues.listComments, {
      owner: this.#context.owner,
      repo: this.#context.repo,
      issue_number: this.#context.number,
      per_page: 100,
    });
    return comments.map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      author: comment.user?.login ?? null,
    }));
  }

  async listReviewThreads() {
    const threads: ReviewThreadNode[] = [];
    let after: string | null = null;
    do {
      const response: ReviewThreadsQuery = await this.#graphql(reviewThreadsQuery, {
        owner: this.#context.owner,
        repo: this.#context.repo,
        number: this.#context.number,
        after,
      });
      const connection = response.repository?.pullRequest?.reviewThreads;
      if (connection === undefined) {
        throw new Error("GitHub pull request was not found while retrieving review threads");
      }
      threads.push(...connection.nodes);
      if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor === null) {
        throw new Error("GitHub returned an invalid review-thread pagination cursor");
      }
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after !== null);

    return threads.map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      comments: thread.comments.nodes.map((comment) => ({
        databaseId: comment.databaseId,
        body: comment.body,
        author: graphqlAuthorLogin(comment.author),
      })),
    }));
  }

  async createInlineComment(
    finding: NewFinding,
    body: string,
    headSha: string,
  ): Promise<string | undefined> {
    const response = await this.#octokit.rest.pulls.createReviewComment({
      owner: this.#context.owner,
      repo: this.#context.repo,
      pull_number: this.#context.number,
      commit_id: headSha,
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body,
    });
    return response.data?.html_url;
  }

  async resolveThread(threadId: string): Promise<void> {
    await this.#graphql(resolveThreadMutation, { threadId });
  }

  async createGeneralComment(body: string): Promise<number> {
    const response = await this.#octokit.rest.issues.createComment({
      owner: this.#context.owner,
      repo: this.#context.repo,
      issue_number: this.#context.number,
      body,
    });
    return response.data.id;
  }

  async updateGeneralComment(commentId: number, body: string): Promise<void> {
    await this.#octokit.rest.issues.updateComment({
      owner: this.#context.owner,
      repo: this.#context.repo,
      comment_id: commentId,
      body,
    });
  }

  async createCheckRun(name: string, headSha: string, state: CheckRunState): Promise<number> {
    const response = await this.#octokit.rest.checks.create({
      owner: this.#context.owner,
      repo: this.#context.repo,
      name,
      head_sha: headSha,
      ...checkRunFields(state),
    });
    return response.data.id;
  }

  async updateCheckRun(checkRunId: number, state: CheckRunState): Promise<void> {
    await this.#octokit.rest.checks.update({
      owner: this.#context.owner,
      repo: this.#context.repo,
      check_run_id: checkRunId,
      ...checkRunFields(state),
    });
  }
}

function checkRunFields(state: CheckRunState) {
  const output = { title: state.title, summary: state.summary };
  return state.conclusion === undefined
    ? { status: "in_progress" as const, output }
    : {
        status: "completed" as const,
        conclusion: state.conclusion,
        completed_at: new Date().toISOString(),
        output,
      };
}

function gitHubCall<A>(
  operation: keyof GitHubReviewClientShape,
  attributes: Record<string, unknown>,
  call: () => Promise<A>,
): Effect.Effect<A, GitHubError> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new GitHubError({
        message: errorMessage(cause),
        operation,
        status: httpStatus(cause),
        cause,
      }),
  }).pipe(Effect.withSpan(`janitor.github.${operation}`, { attributes }));
}

/**
 * Lifts a Promise-based client into the Effect boundary. Every rejection becomes a
 * `GitHubError` carrying the operation and, when present, the HTTP status.
 */
export function gitHubReviewFromClient(client: GitHubReviewClientShape): GitHubReviewBoundary {
  return {
    listGeneralComments: () =>
      gitHubCall("listGeneralComments", {}, () => client.listGeneralComments()),
    listReviewThreads: () => gitHubCall("listReviewThreads", {}, () => client.listReviewThreads()),
    createInlineComment: (finding, body, headSha) =>
      gitHubCall(
        "createInlineComment",
        { "janitor.finding.path": finding.path, "janitor.finding.line": finding.line },
        () => client.createInlineComment(finding, body, headSha),
      ),
    resolveThread: (threadId) =>
      gitHubCall("resolveThread", { "janitor.thread.id": threadId }, () =>
        client.resolveThread(threadId),
      ),
    createGeneralComment: (body) =>
      gitHubCall("createGeneralComment", {}, () => client.createGeneralComment(body)),
    updateGeneralComment: (commentId, body) =>
      gitHubCall("updateGeneralComment", { "janitor.comment.id": commentId }, () =>
        client.updateGeneralComment(commentId, body),
      ),
    createCheckRun: (name, headSha, state) =>
      gitHubCall("createCheckRun", { "janitor.check.name": name }, () =>
        client.createCheckRun(name, headSha, state),
      ),
    updateCheckRun: (checkRunId, state) =>
      gitHubCall(
        "updateCheckRun",
        {
          "janitor.check.id": checkRunId,
          "janitor.check.conclusion": state.conclusion ?? "in_progress",
        },
        () => client.updateCheckRun(checkRunId, state),
      ),
  };
}
