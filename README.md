# Janitor

Making sure your code is clean and secure before it ships to production.

## Requirements

- Node.js 22.22.2 or newer

## Installation

```sh
npm install --global @matfire/janitor
```

## CLI help and version

Running Janitor without a command displays the root help. Long and short help are also available explicitly:

```sh
janitor
janitor --help
janitor -h
janitor --version
```

Use `--help` after a command for its options:

```sh
janitor init --help
janitor review --help
```

## Commands

### Initialize a project

Run the interactive initializer from the repository root:

```sh
janitor init
```

When omitted from the command line, the initializer prompts for:

- the Janitor npm version or tag used by the workflow (default: `latest`)
- confirmation before replacing each changed existing target

The version and overwrite behavior can be supplied with flags for a non-interactive run:

```sh
janitor init --janitor-version latest --force
```

| Flag                                 | Description                                                     |
| ------------------------------------ | --------------------------------------------------------------- |
| `--janitor-version <version-or-tag>` | Select the Janitor npm version or tag embedded in the workflow. |
| `--force`                            | Replace changed generated files without confirmation.           |

Initialization generates:

- `janitor.toml`
- `.github/workflows/janitor.yml`

The default configuration reviews changes to every tracked path:

```toml
version = "latest"

[review]
tracked_paths = ["**"]
```

Add or change tracked path globs directly in `janitor.toml`. A review needs to run when at least one changed path matches one of these patterns. They are independent of `.gitignore`; Git-ignored files are not present in the repository checkout used by the workflow.

Existing files are handled independently. Byte-identical targets are left unchanged without prompting, changed targets require confirmation, and `--force` overwrites all changed targets. Cancelling any prompt before writing leaves both targets untouched.

#### GitHub Actions configuration

Configure all three values as **GitHub Actions secrets** in the repository:

- `JANITOR_PROVIDER`
- `JANITOR_MODEL`
- `JANITOR_PROVIDER_KEY`

Optionally configure `JANITOR_VERBOSE` as a **GitHub Actions repository variable** with the value `1` to enable detailed review logs in the generated workflow.

The generated pull-request workflow grants only `contents: read` and `pull-requests: write`. It uses `GITHUB_TOKEN` to update the pull request and post PR-level and diff comments. The workflow intentionally skips pull requests from forks because repository secrets and write access are unavailable to those runs. Runs are grouped by pull request and a newer event cancels an obsolete in-progress review.

The selected `version` is rendered into the workflow when it is generated. Editing `version` in `janitor.toml` does not update an existing workflow; regenerate the workflow after changing it. A dedicated update command is planned but is not currently available.

### Review a pull request

The generated workflow runs the review command for same-repository pull requests:

```sh
janitor review
```

`review` is PR-only. It reads the standard GitHub Actions pull-request event, verifies that the checkout is at the PR head, and compares the PR merge base with that head. Running it outside a pull-request Actions job, including as a local staged-change review, is not currently supported.

Before invoking the model, Janitor loads `janitor.toml`. The review is skipped when none of the changed paths (including the old path of a rename) match `review.tracked_paths`. A match enables review of the complete PR diff.

Janitor appends a marked status block to the pull request description while preserving its author-written content. The status shows when a review is running, completed, skipped, or failed. A completed 5/5-confidence review uses a thumbs-up indicator; other successful reviews use a checkmark.

Detailed Actions logging is disabled by default. Enable it in the generated workflow by setting the optional GitHub Actions repository variable `JANITOR_VERBOSE` to `1`. When invoking the command directly, use either `janitor review --verbose` or `JANITOR_VERBOSE=1`. Verbose output reports review setup, diff collection, previous-feedback loading, validation, publication, and concise agent activity. Tool starts/results, retries, and context compaction are visible, but model narration and raw tool results are not emitted.

The coding agent receives read-only repository search tools and the PR diff. It maps imports, callers, and usages; checks the changed code for correctness errors, typos, bad patterns, and missed or premature optimizations; and produces:

- inline PR review comments anchored to the changed lines where new issues were found
- one editable PR Conversation comment containing the overall summary, a Mermaid change map, and a confidence score from 1 to 5 with its rationale

Janitor creates its marked general comment as soon as the first review starts, then updates that same comment with the result. Because reruns edit the original comment instead of posting another one, it keeps its early position in the Conversation while later commits and automation accumulate below it. A failed review updates the comment with a failure state.

Each rerun reviews the full current diff and re-evaluates Janitor's unresolved threads. Findings that are still present remain open without duplicate comments, findings explicitly verified as fixed are resolved, and new findings receive new inline comments. Only Janitor-authored marked threads are eligible for automatic resolution; user and third-party review threads are never changed.

## Adding a command

Commands use a flat module layout under `src/commands/`. Keep a command in one file until it has supporting code worth colocating in its own directory.

Each command module should:

1. Declare its flags and help metadata with Cleye.
2. Keep its business handler separate from argument parsing.
3. Export an argv-aware runner with an injectable action for isolated tests.
4. Default-export a zero-argument loader entry point.

Register the module in the command map in `src/cli.ts` using a lazy import:

```ts
commands: {
  inspect: {
    description: "Inspect the current project",
    loader: () => import("#/commands/inspect"),
  },
}
```

Cleye then generates root and command-level help, validates declared flags, and routes the command. Enable command-specific options in the command module rather than the root entry point.
