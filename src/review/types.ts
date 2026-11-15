import type { Effect, Redacted } from "effect";
import type {
  AgentError,
  GitError,
  GitHubError,
  ModelUnavailable,
  ProviderError,
} from "#/review/errors";

export type DiffSide = "LEFT" | "RIGHT";

export interface PullRequestContext {
  repository: string;
  owner: string;
  repo: string;
  number: number;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
}

export interface ReviewEnvironment {
  githubToken: Redacted.Redacted<string>;
  githubEventPath: string;
  githubRepository: string;
  githubApiUrl: string;
  githubGraphqlUrl: string;
  provider: string;
  providerKey: Redacted.Redacted<string>;
  model: string;
  /** Overrides the provider's default API endpoint, e.g. for a proxy or gateway. */
  baseUrl?: string;
}

export type ChangedFileStatus = "added" | "copied" | "deleted" | "modified" | "renamed";

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: ChangedFileStatus;
  patch: string;
  commentableLines: {
    left: ReadonlySet<number>;
    right: ReadonlySet<number>;
  };
}

export interface ReviewDiff {
  mergeBase: string;
  headSha: string;
  files: ChangedFile[];
}

/** What Janitor recorded about its last successful review of a pull request. */
export interface ReviewedState {
  headSha: string;
  /** The general review published at `headSha`, so a re-review can revise it. */
  summary?: string;
  mermaid?: string;
}

/** A pull-request file whose content changed between the last reviewed commit and head. */
export interface IncrementalFile {
  path: string;
  previousPath?: string;
  /** Unified diff from the last reviewed commit to head. */
  patch: string;
  /** Head-side lines changed since the last review that are also part of the pull-request diff. */
  rightLines: ReadonlySet<number>;
}

/** Narrows a re-review to what changed since the last successful review. */
export interface IncrementalReview {
  previous: ReviewedState;
  files: IncrementalFile[];
}

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface NewFinding {
  title: string;
  body: string;
  severity: FindingSeverity;
  path: string;
  side: DiffSide;
  line: number;
}

export interface FindingReply {
  author: string | null;
  body: string;
}

export interface ExistingFinding {
  threadId: string;
  commentId: number | null;
  path: string;
  line: number | null;
  originalLine: number | null;
  isOutdated: boolean;
  body: string;
  /** Comments posted under the finding, oldest first. */
  replies: FindingReply[];
}

/** A resolved Janitor finding whose thread received replies. */
export interface ResolvedFindingDiscussion {
  path: string;
  line: number | null;
  originalLine: number | null;
  isOutdated: boolean;
  body: string;
  replies: FindingReply[];
}

export type ExistingFindingDisposition =
  | { threadId: string; status: "still_present" }
  | { threadId: string; status: "fixed"; reason: string }
  | { threadId: string; status: "dismissed"; reason: string };

export interface GeneralReview {
  summary: string;
  mermaid: string;
  confidence: number;
  confidenceReason: string;
}

export interface ModelReviewResult {
  findings: NewFinding[];
  dispositions: ExistingFindingDisposition[];
  general: GeneralReview | undefined;
}

/** Model reasoning effort levels accepted by the pi agent session. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ReviewAgentInput {
  cwd: string;
  /** Requested reasoning effort; pi defaults to `medium` and clamps it to the model's support. */
  thinkingLevel?: ThinkingLevel;
  context: PullRequestContext;
  diff: ReviewDiff;
  /** Set for a re-review that only reports issues introduced since the last review. */
  incremental?: IncrementalReview;
  previousFindings: ExistingFinding[];
  resolvedDiscussions: ResolvedFindingDiscussion[];
}

export interface ReviewUsageDelta {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

export interface ReviewSpendEntry extends ReviewUsageDelta {
  completedAt: string;
  headSha: string;
  status: "succeeded" | "failed";
}

export type ReviewUsageReporter = (usage: ReviewUsageDelta) => void;

export interface ReviewAgentBoundary {
  run(
    input: ReviewAgentInput,
    reportUsage?: ReviewUsageReporter,
  ): Effect.Effect<ModelReviewResult, ModelUnavailable | ProviderError | AgentError>;
}

export interface GitCommandBoundary {
  run(args: string[], cwd: string): Effect.Effect<string, GitError>;
}

export interface ExistingGeneralComment {
  id: number;
  body: string;
}

export interface GeneralCommentRecord {
  id: number;
  body: string;
  author: string | null;
}

export interface ReviewThreadRecord {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: Array<{ databaseId: number | null; body: string; author: string | null }>;
}

/** The Promise-based GitHub operations Janitor performs, as `GitHubReviewClient` implements them. */
export interface GitHubReviewClientShape {
  listGeneralComments(): Promise<GeneralCommentRecord[]>;
  listReviewThreads(): Promise<ReviewThreadRecord[]>;
  /** Returns the created comment's web URL, when GitHub provides one. */
  createInlineComment(
    finding: NewFinding,
    body: string,
    headSha: string,
  ): Promise<string | undefined>;
  resolveThread(threadId: string): Promise<void>;
  createGeneralComment(body: string): Promise<number>;
  updateGeneralComment(commentId: number, body: string): Promise<void>;
}

export interface GitHubReviewBoundary {
  listGeneralComments(): Effect.Effect<GeneralCommentRecord[], GitHubError>;
  listReviewThreads(): Effect.Effect<ReviewThreadRecord[], GitHubError>;
  /** Returns the created comment's web URL, when GitHub provides one. */
  createInlineComment(
    finding: NewFinding,
    body: string,
    headSha: string,
  ): Effect.Effect<string | undefined, GitHubError>;
  resolveThread(threadId: string): Effect.Effect<void, GitHubError>;
  createGeneralComment(body: string): Effect.Effect<number, GitHubError>;
  updateGeneralComment(commentId: number, body: string): Effect.Effect<void, GitHubError>;
}
