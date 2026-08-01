import type { ReviewSpendEntry, ReviewUsageDelta, ReviewUsageReporter } from "#/review/types";

export const MAX_SPEND_ENTRIES = 50;
export const SPEND_METADATA_MARKER = "<!-- janitor:spend:v1";

const SPEND_METADATA_END_MARKER = "-->";
const SPEND_METADATA_PATTERN = /<!-- janitor:spend:v1\r?\n([^]*?)\r?\n-->/u;
const LEGACY_SPEND_METADATA_PATTERN =
  /<!-- janitor:spend:v1 -->\r?\n([^]*?)\r?\n<!-- \/janitor:spend:v1 -->/u;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSpendEntry(value: unknown): value is ReviewSpendEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const completedAt =
    typeof entry.completedAt === "string" ? new Date(entry.completedAt) : undefined;
  return (
    completedAt !== undefined &&
    Number.isFinite(completedAt.getTime()) &&
    completedAt.toISOString() === entry.completedAt &&
    typeof entry.headSha === "string" &&
    entry.headSha.length <= 128 &&
    /^[0-9A-Za-z._-]+$/u.test(entry.headSha) &&
    (entry.status === "succeeded" || entry.status === "failed") &&
    isFiniteNonNegative(entry.inputTokens) &&
    isFiniteNonNegative(entry.outputTokens) &&
    (entry.estimatedCostUsd === undefined || isFiniteNonNegative(entry.estimatedCostUsd))
  );
}

export function parseSpendHistory(body: string): ReviewSpendEntry[] {
  const metadata =
    SPEND_METADATA_PATTERN.exec(body)?.[1] ?? LEGACY_SPEND_METADATA_PATTERN.exec(body)?.[1];
  if (metadata === undefined) return [];
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const entries = (parsed as Record<string, unknown>).entries;
    if (!Array.isArray(entries) || !entries.every(isSpendEntry)) return [];
    return entries.slice(-MAX_SPEND_ENTRIES);
  } catch {
    return [];
  }
}

export function appendSpendEntry(
  history: readonly ReviewSpendEntry[],
  entry: ReviewSpendEntry,
): ReviewSpendEntry[] {
  return [...history, entry].slice(-MAX_SPEND_ENTRIES);
}

export interface ReviewUsageAccumulator {
  report: ReviewUsageReporter;
  snapshot(): ReviewUsageDelta;
}

export function createReviewUsageAccumulator(): ReviewUsageAccumulator {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd: number | undefined;
  return {
    report(delta) {
      inputTokens += delta.inputTokens;
      outputTokens += delta.outputTokens;
      if (delta.estimatedCostUsd !== undefined) {
        estimatedCostUsd = (estimatedCostUsd ?? 0) + delta.estimatedCostUsd;
      }
    },
    snapshot() {
      return { inputTokens, outputTokens, estimatedCostUsd };
    },
  };
}

export function completedSpendEntry(
  headSha: string,
  status: ReviewSpendEntry["status"],
  usage: ReviewUsageDelta,
  completedAt = new Date(),
): ReviewSpendEntry {
  return { completedAt: completedAt.toISOString(), headSha, status, ...usage };
}

export function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat("en-US").format(tokens);
}

export function formatEstimatedCost(cost: number | undefined): string {
  return cost === undefined ? "—" : `$${cost.toFixed(4)}`;
}

export function renderSpendHistory(history: readonly ReviewSpendEntry[]): string {
  if (history.length === 0) return "";
  const entries = history.slice(-MAX_SPEND_ENTRIES);
  const rows = entries.map(
    (entry) =>
      `| ${entry.completedAt} | \`${entry.headSha}\` | ${entry.status} | ${formatTokenCount(entry.inputTokens)} | ${formatTokenCount(entry.outputTokens)} | ${formatEstimatedCost(entry.estimatedCostUsd)} |`,
  );
  const metadata = JSON.stringify({ entries });
  return `\n### Spend\n\n| Completed (UTC) | Commit | Result | Input tokens | Output tokens | Estimated cost |\n| --- | --- | --- | ---: | ---: | ---: |\n${rows.join("\n")}\n\n${SPEND_METADATA_MARKER}\n${metadata}\n${SPEND_METADATA_END_MARKER}\n`;
}

export function trimSpendHistoryToFit(
  history: readonly ReviewSpendEntry[],
  render: (entries: readonly ReviewSpendEntry[]) => string,
  limit: number,
): { body: string; history: ReviewSpendEntry[] } {
  const retained = history.slice(-MAX_SPEND_ENTRIES);
  let body = render(retained);
  while (body.length > limit && retained.length > 0) {
    retained.shift();
    body = render(retained);
  }
  return { body, history: retained };
}
