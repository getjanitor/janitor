import type { ReviewedState } from "#/review/types";

export const REVIEWED_STATE_MARKER = "<!-- janitor:reviewed:v1";

const REVIEWED_STATE_PATTERN = /<!-- janitor:reviewed:v1\r?\n([^]*?)\r?\n-->/u;

// The SHA is later passed to git as a revision, so it must never look like an option.
const REVISION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u;

// Bounds what a hand-edited comment can inject into the next prompt.
const MAX_CARRIED_TEXT = 20_000;

function carriedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CARRIED_TEXT
    ? value
    : undefined;
}

export function parseReviewedState(body: string): ReviewedState | undefined {
  const metadata = REVIEWED_STATE_PATTERN.exec(body)?.[1];
  if (metadata === undefined) return undefined;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.headSha !== "string" || !REVISION_PATTERN.test(record.headSha)) {
      return undefined;
    }
    const state: ReviewedState = { headSha: record.headSha };
    const summary = carriedText(record.summary);
    const mermaid = carriedText(record.mermaid);
    if (summary !== undefined) state.summary = summary;
    if (mermaid !== undefined) state.mermaid = mermaid;
    return state;
  } catch {
    return undefined;
  }
}

/**
 * Renders the state as a hidden HTML comment. Escaping `<`, `>` and `&` keeps
 * model-authored text from closing the comment early while staying valid JSON.
 */
export function renderReviewedState(state: ReviewedState | undefined): string {
  if (state === undefined) return "";
  const json = JSON.stringify(state).replace(
    /[<>&]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `\n${REVIEWED_STATE_MARKER}\n${json}\n-->\n`;
}
