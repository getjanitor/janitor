import type { ExistingFinding, GeneralReview, NewFinding } from "#/review/types";

export const GENERAL_REVIEW_MARKER = "<!-- janitor:general-review:v1 -->";
export const FINDING_MARKER = "<!-- janitor:finding:v1 -->";

export function renderFindingComment(finding: NewFinding): string {
  return `${FINDING_MARKER}\n**${finding.severity.toUpperCase()}: ${finding.title}**\n\n${finding.body}`;
}

export function renderGeneralComment(
  general: GeneralReview,
  counts: { newFindings: number; stillOpen: number; fixed: number },
): string {
  return `${GENERAL_REVIEW_MARKER}
## Janitor review

${general.summary}

### Change map

\`\`\`mermaid
${general.mermaid.trim()}
\`\`\`

### Findings

- New findings: ${counts.newFindings}
- Existing findings still open: ${counts.stillOpen}
- Fixed findings resolved: ${counts.fixed}

### Confidence: ${general.confidence}/5

${general.confidenceReason}
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
