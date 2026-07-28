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

The default configuration runs both review types for every changed path:

```toml
version = "latest"

[review.code]
paths = ["**"]
disabled_findings = "leave_open"

[review.security]
paths = ["**"]
disabled_findings = "leave_open"
```

`review.code.paths` and `review.security.paths` are independent positive glob lists. A changed file is sent only to the matching review type; matching both lists runs both reviews, while matching neither omits the file. Both the old and new paths of a rename are tested. An empty list disables that review type for current files. Patterns use repository-relative paths, include dotfiles, do not support negation, and are independent of `.gitignore`; Git-ignored files are absent from the workflow checkout.

Each type's optional `disabled_findings` setting controls unresolved findings on files that no longer match its paths:

- `leave_open` (default) preserves the thread without sending it to the agent.
- `review` continues sending the existing thread to that type's agent for disposition, but does not permit new findings on the disabled file.
- `resolve` automatically resolves the thread without model review.

The `[review.code]` and `[review.security]` sections are required. The former `review.tracked_paths` configuration is not supported.

Existing files are handled independently. Byte-identical targets are left unchanged without prompting, changed targets require confirmation, and `--force` overwrites all changed targets. Cancelling any prompt before writing leaves both targets untouched.

#### GitHub Actions configuration

Configure all three values as **GitHub Actions secrets** in the repository:

- `JANITOR_PROVIDER`
- `JANITOR_MODEL`
- `JANITOR_PROVIDER_KEY`

The generated pull-request workflow grants only `contents: read` and `pull-requests: write`. It uses `GITHUB_TOKEN` to post PR-level and diff comments, and it intentionally skips pull requests from forks because repository secrets and write access are unavailable to those runs.

The selected `version` is rendered into the workflow when it is generated. Editing `version` in `janitor.toml` does not update an existing workflow; regenerate the workflow after changing it. A dedicated update command is planned but is not currently available.

### Review a pull request

The generated workflow runs the review command for same-repository pull requests:

```sh
janitor review
```

`review` is PR-only. It reads the standard GitHub Actions pull-request event, verifies that the checkout is at the PR head, and compares the PR merge base with that head. Running it outside a pull-request Actions job, including as a local staged-change review, is not currently supported.

Before invoking a model, Janitor loads `janitor.toml` and builds a filtered diff for each review type. Code review checks its scoped files for correctness, maintainability, naming/documentation, and performance issues. Security review separately checks its scoped files for concrete vulnerabilities. Repository search remains available so each agent can trace imports, callers, and usages, but the diff tool and new-finding validation permit only that run's configured files.

Each executed type produces:

- visibly typed inline PR review comments anchored to changed lines where new issues were found
- its own editable PR Conversation comment ("Janitor code review" or "Janitor security review") containing a summary, Mermaid change map, finding counts, and a confidence score from 1 to 5 with its rationale

A type runs when it has at least one matched changed file or an existing finding selected by the `review` policy. If neither type has work and both policies are `leave_open`, Janitor skips before accessing GitHub comments or invoking a model. Configuration-only `resolve` actions can run without creating a new model summary.

Janitor's typed markers make reruns idempotent and keep the two lifecycles independent. Each agent re-evaluates only its selected unresolved threads. Findings that remain present stay open without duplicate comments, findings verified as fixed are resolved, and new findings receive new inline comments. Outputs from every applicable agent are validated before Janitor performs any GitHub mutation, so an invalid code or security result cannot partially post the other result.

Only Janitor-authored, type-marked threads are eligible for automatic or configuration-driven resolution. User and third-party review threads are never changed.

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
