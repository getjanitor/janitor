export const REVIEW_TYPES = ["code", "security"] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

export const REVIEW_TYPE_METADATA: Record<ReviewType, { label: string; heading: string }> = {
  code: { label: "code", heading: "Janitor code review" },
  security: { label: "security", heading: "Janitor security review" },
};

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
  githubToken: string;
  githubEventPath: string;
  githubRepository: string;
  githubApiUrl: string;
  githubGraphqlUrl: string;
  provider: string;
  providerKey: string;
  model: string;
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

export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface NewFinding {
  reviewType: ReviewType;
  title: string;
  body: string;
  severity: FindingSeverity;
  path: string;
  side: DiffSide;
  line: number;
}

export interface ExistingFinding {
  reviewType: ReviewType;
  threadId: string;
  commentId: number | null;
  path: string;
  line: number | null;
  originalLine: number | null;
  isOutdated: boolean;
  body: string;
}

export type ExistingFindingDisposition =
  | { threadId: string; status: "still_present" }
  | { threadId: string; status: "fixed"; reason: string };

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

export interface ReviewAgentInput {
  reviewType: ReviewType;
  cwd: string;
  context: PullRequestContext;
  diff: ReviewDiff;
  previousFindings: ExistingFinding[];
}

export interface ReviewAgentBoundary {
  run(input: ReviewAgentInput): Promise<ModelReviewResult>;
}

export interface GitCommandBoundary {
  run(args: string[], cwd: string): Promise<string>;
}

export interface ExistingGeneralComment {
  id: number;
  body: string;
}

export interface GitHubReviewBoundary {
  listGeneralComments(): Promise<Array<{ id: number; body: string; author: string | null }>>;
  listReviewThreads(): Promise<
    Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      comments: Array<{ databaseId: number | null; body: string; author: string | null }>;
    }>
  >;
  createInlineComment(finding: NewFinding, body: string, headSha: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  createGeneralComment(body: string): Promise<void>;
  updateGeneralComment(commentId: number, body: string): Promise<void>;
}
