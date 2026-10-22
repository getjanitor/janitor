import { renderSpendHistory } from "#/review/spend";
export { SPEND_METADATA_MARKER } from "#/review/spend";
import type {
  ExistingFinding,
  FindingSeverity,
  GeneralReview,
  NewFinding,
  ReviewSpendEntry,
} from "#/review/types";

const JANITOR_MARKER_NAMESPACE = "janitor:";

export const RESERVED_JANITOR_MARKER_PREFIX = `<!-- ${JANITOR_MARKER_NAMESPACE}`;
export const GENERAL_REVIEW_MARKER = `${RESERVED_JANITOR_MARKER_PREFIX}general-review:v1 -->`;
export const FINDING_MARKER = `${RESERVED_JANITOR_MARKER_PREFIX}finding:v1 -->`;
export const REVIEW_STATUS_MARKER = `${JANITOR_MARKER_NAMESPACE}review-status:v1`;

export type ReviewDescriptionStatus =
  | "running"
  | "complete"
  | "complete-max-confidence"
  | "skipped"
  | "failed";

const REVIEW_STATUS_END_MARKER = `<!-- /${REVIEW_STATUS_MARKER} -->`;
const REVIEW_STATUS_BLOCK_PATTERN = new RegExp(
  String.raw`(?:\r?\n){0,2}<!-- ${REVIEW_STATUS_MARKER} head=([^\s>]+) -->\r?\n[^\r\n]*\r?\n<!-- \/${REVIEW_STATUS_MARKER} -->`,
  "gu",
);

const REVIEW_STATUS_TEXT: Record<ReviewDescriptionStatus, string> = {
  running: "👀 Janitor review in progress",
  complete: "✅ Janitor review complete",
  "complete-max-confidence": "👍 Janitor review complete — confidence 5/5",
  skipped: "⏭️ Janitor review skipped — no tracked paths changed",
  failed: "❌ Janitor review failed",
};

function currentStatusHead(body: string): string | undefined {
  const matches = [...body.matchAll(REVIEW_STATUS_BLOCK_PATTERN)];
  const encodedHead = matches.at(-1)?.[1];
  if (encodedHead === undefined) return undefined;
  try {
    return decodeURIComponent(encodedHead);
  } catch {
    return encodedHead;
  }
}

export function renderReviewDescriptionStatus(
  headSha: string,
  status: ReviewDescriptionStatus,
): string {
  return `<!-- ${REVIEW_STATUS_MARKER} head=${encodeURIComponent(headSha)} -->\n${REVIEW_STATUS_TEXT[status]}\n${REVIEW_STATUS_END_MARKER}`;
}

export function reconcileReviewDescription(
  body: string,
  headSha: string,
  status: ReviewDescriptionStatus,
): string {
  const currentHead = currentStatusHead(body);
  if (status !== "running" && currentHead !== undefined && currentHead !== headSha) {
    return body;
  }

  const authorBody = body.replace(REVIEW_STATUS_BLOCK_PATTERN, "");
  const separator = authorBody.length === 0 ? "" : "\n\n";
  return `${authorBody}${separator}${renderReviewDescriptionStatus(headSha, status)}`;
}

export function renderFindingComment(finding: NewFinding): string {
  return `${FINDING_MARKER}\n**${finding.severity.toUpperCase()}: ${finding.title}**\n\n${finding.body}`;
}

export function renderGeneralCommentStatus(
  status: "running" | "failed",
  spendHistory?: readonly ReviewSpendEntry[],
): string {
  const message =
    status === "running"
      ? "👀 Review in progress…"
      : "❌ Review failed. See the workflow logs for details.";
  return `${GENERAL_REVIEW_MARKER}\n## Janitor review\n\n${message}\n${renderSpendHistory(spendHistory ?? [])}`;
}

const SEVERITY_BADGE_COLOR: Record<FindingSeverity, string> = {
  critical: "critical",
  high: "orange",
  medium: "yellow",
  low: "lightgrey",
};

export interface GeneralCommentFinding {
  title: string;
  severity: FindingSeverity;
  url?: string;
}

function renderSeverityBadge(severity: FindingSeverity): string {
  return `![${severity}](https://img.shields.io/badge/${severity}-${SEVERITY_BADGE_COLOR[severity]})`;
}

function renderFindingsSection(
  findings: readonly GeneralCommentFinding[],
  counts: { stillOpen: number; fixed: number },
): string {
  const items = findings.map((finding, index) => {
    const title = finding.title.replace(/\s+/gu, " ").trim();
    const link = finding.url === undefined ? "" : ` [►](${finding.url})`;
    return `${index + 1}. ${renderSeverityBadge(finding.severity)} **${title}**${link}`;
  });
  const list = items.length === 0 ? "No new findings." : items.join("\n");
  return `${list}\n\nExisting findings still open: ${counts.stillOpen} · Fixed findings resolved: ${counts.fixed}`;
}

export function renderGeneralComment(
  general: GeneralReview,
  findings: readonly GeneralCommentFinding[],
  counts: { stillOpen: number; fixed: number },
  spendHistory?: readonly ReviewSpendEntry[],
): string {
  return `${GENERAL_REVIEW_MARKER}
## Janitor review

### Findings

${renderFindingsSection(findings, counts)}

### Summary

${general.summary}

### Change map

\`\`\`mermaid
${general.mermaid.trim()}
\`\`\`

### Confidence: ${general.confidence}/5

${general.confidenceReason}
${renderSpendHistory(spendHistory ?? [])}
`;
}

interface ThreadShape {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: Array<{ databaseId: number | null; body: string; author: string | null }>;
}

function isBotAuthor(author: string | null): boolean {
  return author?.endsWith("[bot]") ?? false;
}

export function findJanitorGeneralComment(
  comments: Array<{ id: number; body: string; author: string | null }>,
): { id: number; body: string } | undefined {
  return comments.find(
    (comment) => isBotAuthor(comment.author) && comment.body.includes(GENERAL_REVIEW_MARKER),
  );
}

export function findOpenJanitorFindings(threads: ThreadShape[]): ExistingFinding[] {
  return threads.flatMap((thread) => {
    if (thread.isResolved) {
      return [];
    }
    // Janitor creates standalone inline comments, so ownership belongs to the
    // thread's root comment. A later Janitor reply must not make a user-owned
    // thread eligible for automatic resolution.
    const comment = thread.comments[0];
    if (!isBotAuthor(comment?.author ?? null) || !comment.body.includes(FINDING_MARKER)) {
      return [];
    }
    return [
      {
        threadId: thread.id,
        commentId: comment.databaseId,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        isOutdated: thread.isOutdated,
        body: comment.body.replace(FINDING_MARKER, "").trim(),
      },
    ];
  });
}
