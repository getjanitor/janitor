import {
  REVIEW_TYPES,
  REVIEW_TYPE_METADATA,
  type ExistingFinding,
  type GeneralReview,
  type NewFinding,
  type ReviewType,
} from "#/review/types";

export function generalReviewMarker(reviewType: ReviewType): string {
  return `<!-- janitor:general-review:${reviewType}:v1 -->`;
}

export function findingMarker(reviewType: ReviewType): string {
  return `<!-- janitor:finding:${reviewType}:v1 -->`;
}

export function renderFindingComment(finding: NewFinding): string {
  const type = REVIEW_TYPE_METADATA[finding.reviewType].label.toUpperCase();
  return `${findingMarker(finding.reviewType)}\n**${type} · ${finding.severity.toUpperCase()}: ${finding.title}**\n\n${finding.body}`;
}

export function renderGeneralComment(
  reviewType: ReviewType,
  general: GeneralReview,
  counts: {
    newFindings: number;
    stillOpen: number;
    fixed: number;
    configurationResolved: number;
  },
): string {
  return `${generalReviewMarker(reviewType)}
## ${REVIEW_TYPE_METADATA[reviewType].heading}

${general.summary}

### Change map

\`\`\`mermaid
${general.mermaid.trim()}
\`\`\`

### Findings

- New findings: ${counts.newFindings}
- Existing findings still open: ${counts.stillOpen}
- Fixed findings resolved: ${counts.fixed}
- Findings resolved by configuration: ${counts.configurationResolved}

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
  reviewType: ReviewType,
): { id: number; body: string } | undefined {
  const marker = generalReviewMarker(reviewType);
  return comments.find((comment) => isBotAuthor(comment.author) && comment.body.startsWith(marker));
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
    if (!isBotAuthor(comment?.author ?? null)) {
      return [];
    }
    const reviewType = REVIEW_TYPES.find((candidate) =>
      comment.body.startsWith(findingMarker(candidate)),
    );
    if (reviewType === undefined) {
      return [];
    }
    const marker = findingMarker(reviewType);
    return [
      {
        reviewType,
        threadId: thread.id,
        commentId: comment.databaseId,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        isOutdated: thread.isOutdated,
        body: comment.body.slice(marker.length).trim(),
      },
    ];
  });
}
