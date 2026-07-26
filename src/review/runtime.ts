import { readFile } from "node:fs/promises";
import { type } from "arktype";
import type { PullRequestContext, ReviewEnvironment } from "#/review/types";

const pullRequestEventSchema = type({
  repository: { full_name: "string" },
  pull_request: {
    number: "number.integer > 0",
    base: {
      ref: "string > 0",
      sha: "string > 0",
      repo: { full_name: "string > 0" },
    },
    head: {
      ref: "string > 0",
      sha: "string > 0",
      repo: { full_name: "string > 0" },
    },
  },
});

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function readReviewEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ReviewEnvironment {
  return {
    githubToken: requiredEnvironmentValue(environment, "GITHUB_TOKEN"),
    githubEventPath: requiredEnvironmentValue(environment, "GITHUB_EVENT_PATH"),
    githubRepository: requiredEnvironmentValue(environment, "GITHUB_REPOSITORY"),
    githubApiUrl: environment.GITHUB_API_URL ?? "https://api.github.com",
    githubGraphqlUrl: environment.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql",
    provider: requiredEnvironmentValue(environment, "JANITOR_PROVIDER"),
    providerKey: requiredEnvironmentValue(environment, "JANITOR_PROVIDER_KEY"),
    model: requiredEnvironmentValue(environment, "JANITOR_MODEL"),
  };
}

export async function readPullRequestContext(
  eventPath: string,
  expectedRepository: string,
): Promise<PullRequestContext> {
  let event: unknown;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read GitHub pull-request event at ${eventPath}`, { cause: error });
  }

  const parsed = pullRequestEventSchema.assert(event);
  const repository = parsed.repository.full_name;
  if (repository !== expectedRepository) {
    throw new Error(
      `GitHub event repository ${repository} does not match GITHUB_REPOSITORY ${expectedRepository}`,
    );
  }
  if (
    parsed.pull_request.head.repo.full_name !== repository ||
    parsed.pull_request.base.repo.full_name !== repository
  ) {
    throw new Error(
      "Janitor only supports pull requests whose head and base are in this repository",
    );
  }

  const separator = repository.indexOf("/");
  if (separator <= 0 || separator === repository.length - 1) {
    throw new Error(`Invalid GitHub repository name: ${repository}`);
  }

  return {
    repository,
    owner: repository.slice(0, separator),
    repo: repository.slice(separator + 1),
    number: parsed.pull_request.number,
    baseRef: parsed.pull_request.base.ref,
    baseSha: parsed.pull_request.base.sha,
    headRef: parsed.pull_request.head.ref,
    headSha: parsed.pull_request.head.sha,
  };
}
