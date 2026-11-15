import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingReviewAgent } from "#/review/agent";
import { AgentError, ModelUnavailable, ProviderError } from "#/review/errors";
import type { ReviewAgentInput, ReviewEnvironment } from "#/review/types";

const pi = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  const session = {
    subscribe: vi.fn((_listener: (event: unknown) => void) => unsubscribe),
    prompt: vi.fn(async (): Promise<void> => undefined),
    dispose: vi.fn(),
    messages: [] as unknown[],
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
  createAgentSession: vi.fn(async () => ({ session: pi.session })),
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

const cleanGeneral = {
  summary: "The change is focused and no actionable issues were found.",
  mermaid: "flowchart LR\n  A[Caller] --> B[Changed code]",
  confidence: 4,
  confidenceReason: "All changed files and their direct callers were inspected.",
};

function failedResponse(errorMessage: string) {
  return { role: "assistant", content: [], stopReason: "error", errorMessage };
}

/** Lets a prompt mock emit session events and call the agent's custom tools. */
async function sessionHarness() {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const options = vi.mocked(createAgentSession).mock.calls.at(-1)?.[0];
  const listener = pi.session.subscribe.mock.calls.at(-1)?.[0];
  if (options === undefined || listener === undefined) throw new Error("No session yet");
  return {
    emit: listener,
    submitReview: async () => {
      const tool = options.customTools?.find((candidate) => candidate.name === "submit_review");
      if (tool === undefined) throw new Error("Missing submit_review");
      await tool.execute("call", cleanGeneral as never, undefined, undefined, undefined as never);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pi.session.messages = [];
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

  it("fails with ProviderError when the provider fails before the review is submitted", async () => {
    pi.session.prompt.mockImplementationOnce(async () => {
      const { emit } = await sessionHarness();
      emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" });
      pi.session.messages = [
        { role: "user", content: "Review pull request #12" },
        failedResponse("529 overloaded"),
      ];
    });

    const error = await Effect.runPromise(
      Effect.flip(new CodingReviewAgent(environment).run(input)),
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      message: "Model provider provider/model failed: 529 overloaded (after 3 retries)",
      provider: "provider",
      model: "model",
      reason: "529 overloaded",
      retryAttempts: 3,
    });
    expect(pi.session.dispose).toHaveBeenCalledOnce();
  });

  it("reports a non-retried provider failure without a retry count", async () => {
    pi.session.prompt.mockImplementationOnce(async () => {
      pi.session.messages = [failedResponse("401 invalid x-api-key")];
    });

    const error = await Effect.runPromise(
      Effect.flip(new CodingReviewAgent(environment).run(input)),
    );

    expect(error).toMatchObject({
      _tag: "ProviderError",
      message: "Model provider provider/model failed: 401 invalid x-api-key",
      retryAttempts: 0,
    });
  });

  it("keeps a submitted review when a later provider response fails", async () => {
    pi.session.prompt.mockImplementationOnce(async () => {
      const { submitReview } = await sessionHarness();
      await submitReview();
      pi.session.messages = [failedResponse("connection reset")];
    });

    const result = await Effect.runPromise(new CodingReviewAgent(environment).run(input));

    expect(result.general).toEqual(cleanGeneral);
  });
});
