import { Data } from "effect";

/** Invalid or missing configuration: an environment variable or `janitor.toml`. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
  /** The environment variable or file that held the problem. */
  readonly source: string;
  readonly cause?: unknown;
}> {}

/** The GitHub pull-request event could not be read or is not reviewable. */
export class EventError extends Data.TaggedError("EventError")<{
  readonly message: string;
  readonly path: string;
  readonly cause?: unknown;
}> {}

/** A git command failed or produced output that could not be used. */
export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string;
  readonly args: readonly string[];
  readonly cause?: unknown;
}> {}

/** A GitHub API call failed. `status` is the HTTP status when GitHub returned one. */
export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly message: string;
  readonly operation: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/** The configured model is not in the provider catalog, even after a refresh. */
export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly message: string;
  readonly provider: string;
  readonly model: string;
  readonly cause?: unknown;
}> {}

/** The coding agent session failed while running the review. */
export class AgentError extends Data.TaggedError("AgentError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The agent's submitted review breaks a rule Janitor relies on before publishing. */
export class ModelOutputInvalid extends Data.TaggedError("ModelOutputInvalid")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

/** The general review comment cannot fit within GitHub's comment size limit. */
export class CommentTooLarge extends Data.TaggedError("CommentTooLarge")<{
  readonly limit: number;
}> {
  override get message(): string {
    return "General review exceeds GitHub's comment size limit";
  }
}

/** Every failure the review program can produce, before or during orchestration. */
export type ReviewError =
  | ConfigError
  | EventError
  | GitError
  | GitHubError
  | ModelUnavailable
  | AgentError
  | ModelOutputInvalid
  | CommentTooLarge;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the HTTP status Octokit's `RequestError` (and similar errors) carry. */
export function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}
