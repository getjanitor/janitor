import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingReviewAgent } from "#/review/agent";
import { AgentError, ModelUnavailable } from "#/review/errors";
import type { ReviewAgentInput, ReviewEnvironment } from "#/review/types";

const pi = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  const session = {
    subscribe: vi.fn(() => unsubscribe),
    prompt: vi.fn(async (): Promise<void> => undefined),
    dispose: vi.fn(),
  };
  const runtime = {
    setRuntimeApiKey: vi.fn(async () => undefined),
    getModel: vi.fn((): unknown => ({
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    refresh: vi.fn(async () => ({ errors: new Map<string, Error>(), aborted: false })),
  };
  return { unsubscribe, session, runtime };
});

vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => ({
  ...(await importOriginal()),
  ModelRuntime: { create: vi.fn(async () => pi.runtime) } as never,
  SettingsManager: { inMemory: vi.fn(() => ({})) } as never,
  SessionManager: { inMemory: vi.fn(() => ({})) } as never,
  DefaultResourceLoader: class {
    async reload() {}
  } as never,
  getAgentDir: () => "/agent",
  createAgentSession: vi.fn(async () => ({ session: pi.session })) as never,
}));

const environment: ReviewEnvironment = {
  githubToken: Redacted.make("token"),
  githubEventPath: "/event.json",
  githubRepository: "owner/repo",
  githubApiUrl: "https://api.github.com",
  githubGraphqlUrl: "https://api.github.com/graphql",
  provider: "provider",
  providerKey: Redacted.make("provider-key"),
  model: "model",
};

const input: ReviewAgentInput = {
  cwd: "/repo",
  context: {
    repository: "owner/repo",
    owner: "owner",
    repo: "repo",
    number: 12,
    baseRef: "main",
    baseSha: "base-sha",
    headRef: "feature",
    headSha: "head-sha",
  },
  diff: { mergeBase: "merge-sha", headSha: "head-sha", files: [] },
  previousFindings: [],
  resolvedDiscussions: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  pi.session.subscribe.mockImplementation(() => pi.unsubscribe);
  pi.session.prompt.mockImplementation(async () => undefined);
  pi.runtime.getModel.mockImplementation(() => ({
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
});

describe("coding review agent session", () => {
  it("passes the unredacted provider key to pi and releases the session", async () => {
    await Effect.runPromise(new CodingReviewAgent(environment).run(input));

    expect(pi.runtime.setRuntimeApiKey).toHaveBeenCalledWith("provider", "provider-key");
    expect(pi.unsubscribe).toHaveBeenCalledOnce();
    expect(pi.session.dispose).toHaveBeenCalledOnce();
  });

  it("unsubscribes and disposes the session when the prompt fails", async () => {
    const failure = new Error("provider request failed");
    pi.session.prompt.mockRejectedValueOnce(failure);

    const error = await Effect.runPromise(
      Effect.flip(new CodingReviewAgent(environment).run(input)),
    );

    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ message: "provider request failed", cause: failure });
    expect(pi.unsubscribe).toHaveBeenCalledOnce();
    expect(pi.session.dispose).toHaveBeenCalledOnce();
    expect(pi.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
      pi.session.dispose.mock.invocationCallOrder[0]!,
    );
  });

  it("fails with ModelUnavailable when a catalog refresh cannot find the model", async () => {
    pi.runtime.getModel.mockImplementation(() => undefined);
    pi.runtime.refresh.mockResolvedValueOnce({
      errors: new Map([["provider", new Error("401 Unauthorized")]]),
      aborted: true,
    });

    const error = await Effect.runPromise(
      Effect.flip(new CodingReviewAgent(environment).run(input)),
    );

    expect(error).toBeInstanceOf(ModelUnavailable);
    expect(error).toMatchObject({
      provider: "provider",
      model: "model",
      message:
        "Model provider/model is unavailable (catalog refresh failed: provider: 401 Unauthorized; timed out after 15000ms)",
    });
    expect(pi.session.dispose).not.toHaveBeenCalled();
  });
});
