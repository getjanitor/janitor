import { readFile } from "node:fs/promises";
import { Config, ConfigProvider, Effect, Option, Redacted, Schema } from "effect";
import { ConfigError, EventError } from "#/review/errors";
import type { PullRequestContext, ReviewEnvironment } from "#/review/types";

const RepositoryReference = Schema.Struct({
  ref: Schema.NonEmptyString,
  sha: Schema.NonEmptyString,
  repo: Schema.Struct({ full_name: Schema.NonEmptyString }),
});

const PullRequestEvent = Schema.Struct({
  repository: Schema.Struct({ full_name: Schema.String }),
  pull_request: Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    base: RepositoryReference,
    head: RepositoryReference,
  }),
});

function missingVariable(name: string): ConfigError {
  return new ConfigError({
    message: `Missing required environment variable ${name}`,
    source: name,
  });
}

function readVariable<A>(name: string, config: Config.Config<A>) {
  return Config.option(config).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `Unable to read environment variable ${name}`,
          source: name,
          cause,
        }),
    ),
  );
}

// An empty value counts as missing, whether or not the provider preserves empty strings.
function requiredString(name: string): Effect.Effect<string, ConfigError> {
  return readVariable(name, Config.String(name)).pipe(
    Effect.flatMap((value) =>
      Option.isSome(value) && value.value.length > 0
        ? Effect.succeed(value.value)
        : Effect.fail(missingVariable(name)),
    ),
  );
}

function requiredSecret(name: string): Effect.Effect<Redacted.Redacted<string>, ConfigError> {
  return readVariable(name, Config.Redacted(name)).pipe(
    Effect.flatMap((value) =>
      Option.isSome(value) && Redacted.value(value.value).length > 0
        ? Effect.succeed(value.value)
        : Effect.fail(missingVariable(name)),
    ),
  );
}

function stringWithDefault(name: string, fallback: string): Effect.Effect<string, ConfigError> {
  return readVariable(name, Config.String(name)).pipe(
    Effect.map((value) => Option.getOrElse(value, () => fallback)),
  );
}

function optionalBaseUrl(name: string): Effect.Effect<string | undefined, ConfigError> {
  return readVariable(name, Config.String(name)).pipe(
    Effect.flatMap((option) => {
      const value = Option.getOrUndefined(option)?.trim();
      if (value === undefined || value.length === 0) return Effect.succeed(undefined);
      let url: URL;
      try {
        url = new URL(value);
      } catch (cause) {
        return Effect.fail(
          new ConfigError({
            message: `Invalid ${name}: ${value} is not a URL`,
            source: name,
            cause,
          }),
        );
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return Effect.fail(
          new ConfigError({ message: `Invalid ${name}: expected an http(s) URL`, source: name }),
        );
      }
      return Effect.succeed(value.replace(/\/+$/u, ""));
    }),
  );
}

/**
 * Reads the review environment from the current `ConfigProvider`. Variables are validated in
 * declaration order, so the first missing one is the one reported.
 */
export const loadReviewEnvironment: Effect.Effect<ReviewEnvironment, ConfigError> = Effect.gen(
  function* () {
    return {
      githubToken: yield* requiredSecret("GITHUB_TOKEN"),
      githubEventPath: yield* requiredString("GITHUB_EVENT_PATH"),
      githubRepository: yield* requiredString("GITHUB_REPOSITORY"),
      githubApiUrl: yield* stringWithDefault("GITHUB_API_URL", "https://api.github.com"),
      githubGraphqlUrl: yield* stringWithDefault(
        "GITHUB_GRAPHQL_URL",
        "https://api.github.com/graphql",
      ),
      provider: yield* requiredString("JANITOR_PROVIDER"),
      providerKey: yield* requiredSecret("JANITOR_PROVIDER_KEY"),
      model: yield* requiredString("JANITOR_MODEL"),
      baseUrl: yield* optionalBaseUrl("JANITOR_BASE_URL"),
    };
  },
).pipe(Effect.withSpan("janitor.config.environment"));

/**
 * A provider over a plain environment record. Empty strings are kept so an empty
 * `GITHUB_API_URL` behaves as it did before the Effect migration.
 */
export function environmentConfigProvider(
  environment: NodeJS.ProcessEnv = process.env,
): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnvRecord(environment, { preserveEmptyStrings: true });
}

/**
 * Synchronous entry point kept for the public `env` module. It throws the tagged
 * `ConfigError` on invalid input.
 */
export function readReviewEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ReviewEnvironment {
  return Effect.runSync(
    loadReviewEnvironment.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, environmentConfigProvider(environment)),
    ),
  );
}

export const readPullRequestContext = Effect.fn("janitor.event.read_pull_request")(function* (
  eventPath: string,
  expectedRepository: string,
) {
  const event = yield* Effect.tryPromise({
    try: async (): Promise<unknown> => JSON.parse(await readFile(eventPath, "utf8")),
    catch: (cause) =>
      new EventError({
        message: `Unable to read GitHub pull-request event at ${eventPath}`,
        path: eventPath,
        cause,
      }),
  });

  const parsed = yield* Schema.decodeUnknownEffect(PullRequestEvent)(event).pipe(
    Effect.mapError(
      (cause) =>
        new EventError({
          message: `Invalid GitHub pull-request event at ${eventPath}: ${cause.message}`,
          path: eventPath,
          cause,
        }),
    ),
  );
  const fail = (message: string) => Effect.fail(new EventError({ message, path: eventPath }));
  const repository = parsed.repository.full_name;
  if (repository !== expectedRepository) {
    return yield* fail(
      `GitHub event repository ${repository} does not match GITHUB_REPOSITORY ${expectedRepository}`,
    );
  }
  if (
    parsed.pull_request.head.repo.full_name !== repository ||
    parsed.pull_request.base.repo.full_name !== repository
  ) {
    return yield* fail(
      "Janitor only supports pull requests whose head and base are in this repository",
    );
  }

  const separator = repository.indexOf("/");
  if (separator <= 0 || separator === repository.length - 1) {
    return yield* fail(`Invalid GitHub repository name: ${repository}`);
  }

  const context: PullRequestContext = {
    repository,
    owner: repository.slice(0, separator),
    repo: repository.slice(separator + 1),
    number: parsed.pull_request.number,
    baseRef: parsed.pull_request.base.ref,
    baseSha: parsed.pull_request.base.sha,
    headRef: parsed.pull_request.head.ref,
    headSha: parsed.pull_request.head.sha,
  };
  return context;
});
