import { stripVTControlCharacters } from "node:util";
import { CleyeExit } from "cleye";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "#/cli";
import { runInitCommand } from "#/commands/init";
import { runReviewCommand } from "#/commands/review";

const expectExit = async (result: Promise<unknown>, reason: CleyeExit["reason"], code: number) => {
  await expect(result).rejects.toMatchObject({
    name: "CleyeExit",
    reason,
    code,
  });
};

const loggedOutput = (log: ReturnType<typeof vi.spyOn>) =>
  stripVTControlCharacters(String(log.mock.calls[0]?.[0]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("root CLI", () => {
  it("shows long help when no command is provided", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli({ argv: [], throwOnExit: true });

    expect(log).toHaveBeenCalledOnce();
    expect(loggedOutput(log)).toContain("Usage: janitor");
    expect(loggedOutput(log)).toContain("init");
    expect(loggedOutput(log)).toContain("review");
  });

  it("supports root help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expectExit(runCli({ argv: ["--help"], throwOnExit: true }), "help", 0);

    expect(loggedOutput(log)).toContain("Usage: janitor");
  });

  it("supports short root help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expectExit(runCli({ argv: ["-h"], throwOnExit: true }), "help", 0);

    expect(loggedOutput(log)).toContain("Usage: janitor");
  });

  it("prints the package version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expectExit(runCli({ argv: ["--version"], throwOnExit: true }), "version", 0);

    expect(log).toHaveBeenCalledWith("0.0.0");
  });

  it.each([
    ["init", "--janitor-version"],
    ["review", "GitHub pull request"],
  ])("shows help for the %s command", async (command, expectedText) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expectExit(runCli({ argv: [command, "--help"], throwOnExit: true }), "help", 0);

    expect(loggedOutput(log)).toContain(`janitor ${command}`);
    expect(loggedOutput(log)).toContain(expectedText);
  });

  it("rejects unknown commands with a suggestion", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectExit(runCli({ argv: ["reviwe"], throwOnExit: true }), "unknown-command", 1);

    expect(error).toHaveBeenCalledWith(
      'Error: Unknown command: "reviwe". (Did you mean "review"?)',
    );
  });

  it("rejects the removed staged review option", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expectExit(
      runCli({ argv: ["review", "--staged"], throwOnExit: true }),
      "unknown-flag",
      1,
    );

    expect(error).toHaveBeenCalledWith("Error: Unknown flag: --staged.");
  });
});

describe("command actions", () => {
  it("parses and routes init options", async () => {
    const action = vi.fn();

    await runInitCommand(action, ["--janitor-version", "next", "--force"]);

    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith({
      force: true,
      janitorVersion: "next",
    });
  });

  it("leaves omitted init values available for interactive prompting", async () => {
    const action = vi.fn();

    await runInitCommand(action, []);

    expect(action).toHaveBeenCalledWith({
      force: false,
      janitorVersion: undefined,
    });
  });

  it("routes the review command without options", async () => {
    const action = vi.fn();

    await runReviewCommand(action, []);

    expect(action).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledWith();
  });

  it("does not require environment secrets while parsing the review command", async () => {
    const action = vi.fn();

    await runReviewCommand(action, []);

    expect(action).toHaveBeenCalledOnce();
  });
});
