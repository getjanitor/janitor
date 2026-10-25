import { renderSpendHistory } from "#/review/spend";
export { SPEND_METADATA_MARKER } from "#/review/spend";
import type {
  ExistingFinding,
  FindingReply,
  FindingSeverity,
  GeneralReview,
  NewFinding,
  ResolvedFindingDiscussion,
  ReviewSpendEntry,
} from "#/review/types";

const JANITOR_MARKER_NAMESPACE = "janitor:";

export const RESERVED_JANITOR_MARKER_PREFIX = `<!-- ${JANITOR_MARKER_NAMESPACE}`;
export const GENERAL_REVIEW_MARKER = `${RESERVED_JANITOR_MARKER_PREFIX}general-review:v1 -->`;
export const FINDING_MARKER = `${RESERVED_JANITOR_MARKER_PREFIX}finding:v1 -->`;

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

function findingLocation(finding: NewFinding): string {
  return `\`${finding.path}\` line ${finding.line} (${finding.side})`;
}

// GitHub only accepts inline review comments on lines that are part of the
// pull-request diff. Findings that cannot be anchored there are folded into the
// general comment so one misplaced anchor never discards the whole review.
export function renderOutsideDiffFindings(
  findings: readonly NewFinding[],
  detail: "full" | "compact" | "count" = "full",
): string {
  if (findings.length === 0) return "";
  const heading = (finding: NewFinding) =>
    `**${finding.severity.toUpperCase()}: ${finding.title}**`;
  const content =
    detail === "full"
      ? findings
          .map((finding) => `${heading(finding)}\n${findingLocation(finding)}\n\n${finding.body}`)
          .join("\n\n")
      : detail === "compact"
        ? findings
            .map((finding) => `- ${heading(finding)} — ${findingLocation(finding)}`)
            .join("\n")
        : `${findings.length} finding(s) were too large to list here; see the workflow logs for their titles and locations.`;
  return `
### Findings outside the diff

These findings could not be posted as inline comments on the pull request.

${content}
`;
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

// Titles are capped so the list stays bounded however long the model's titles
// are; the full title lives in the linked inline comment.
const LISTED_TITLE_LIMIT = 120;

function listedTitle(title: string): string {
  const collapsed = title.replace(/\s+/gu, " ").trim();
  return collapsed.length <= LISTED_TITLE_LIMIT
    ? collapsed
    : `${collapsed.slice(0, LISTED_TITLE_LIMIT - 1).trimEnd()}…`;
}

export interface FindingCounts {
  stillOpen: number;
  fixed: number;
  dismissed?: number;
  unresolvedFixed?: number;
  unresolvedDismissed?: number;
}

function renderFindingsSection(
  findings: readonly GeneralCommentFinding[],
  counts: FindingCounts,
): string {
  const items = findings.map((finding, index) => {
    const link = finding.url === undefined ? "" : ` [►](${finding.url})`;
    return `${index + 1}. ${renderSeverityBadge(finding.severity)} **${listedTitle(finding.title)}**${link}`;
  });
  const list = items.length === 0 ? "No new findings." : items.join("\n");
  const optionalCounts: Array<[number | undefined, string]> = [
    [counts.dismissed, "Findings dismissed after discussion"],
    [counts.unresolvedFixed, "Fixed findings that could not be resolved automatically"],
    [counts.unresolvedDismissed, "Dismissed findings that could not be resolved automatically"],
  ];
  const extra = optionalCounts
    .filter(([count]) => count)
    .map(([count, label]) => `- ${label}: ${count}\n`)
    .join("");
  return `${list}

- Existing findings still open: ${counts.stillOpen}
- Fixed findings resolved: ${counts.fixed}
${extra}`;
}

export function renderGeneralComment(
  general: GeneralReview,
  findings: readonly GeneralCommentFinding[],
  counts: FindingCounts,
  spendHistory?: readonly ReviewSpendEntry[],
  outsideDiff = "",
): string {
  return `${GENERAL_REVIEW_MARKER}
## Janitor review

### Findings

${renderFindingsSection(findings, counts)}
${outsideDiff}
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

// Janitor creates standalone inline comments, so ownership belongs to the
// thread's root comment. A later Janitor reply must not make a user-owned
// thread eligible for automatic resolution.
function janitorFindingRoot(thread: ThreadShape) {
  const comment = thread.comments[0];
  return isBotAuthor(comment?.author ?? null) && comment.body.includes(FINDING_MARKER)
    ? comment
    : undefined;
}

function threadReplies(thread: ThreadShape): FindingReply[] {
  return thread.comments.slice(1).map((reply) => ({ author: reply.author, body: reply.body }));
}

export function findOpenJanitorFindings(threads: ThreadShape[]): ExistingFinding[] {
  return threads.flatMap((thread) => {
    const comment = janitorFindingRoot(thread);
    if (thread.isResolved || comment === undefined) {
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
        replies: threadReplies(thread),
      },
    ];
  });
}

// Resolved findings that someone discussed let the agent avoid re-reporting an
// issue that was already rejected, without replaying every silently fixed one.
export function findResolvedJanitorDiscussions(
  threads: ThreadShape[],
): ResolvedFindingDiscussion[] {
  return threads.flatMap((thread) => {
    const comment = janitorFindingRoot(thread);
    const replies = threadReplies(thread);
    if (!thread.isResolved || comment === undefined || replies.length === 0) {
      return [];
    }
    return [
      {
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        body: comment.body.replace(FINDING_MARKER, "").trim(),
        replies,
      },
    ];
  });
}
