import { Cause, Context, Option } from "effect";

const MAX_CAUSE_DEPTH = 6;
const OMITTED_FIELDS = new Set(["_tag", "name", "message", "cause", "stack"]);

function indent(text: string, prefix: string): string {
  return text
    .trimEnd()
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

function formatField(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(" ");
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const tag = (error as { _tag?: unknown })._tag;
    const label = typeof tag === "string" ? tag : error.name;
    return error.message.length > 0 ? `${label}: ${error.message}` : label;
  }
  return String(error);
}

function fieldLines(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return [];
  return Object.entries(error)
    .filter(([key, value]) => !OMITTED_FIELDS.has(key) && value !== undefined)
    .map(([key, value]) => `  ${key}: ${indent(formatField(value), "    ")}`);
}

function causeLines(error: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>([error]);
  let current = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    lines.push(`  caused by: ${indent(describe(current), "    ")}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines;
}

/** Span names from the failure's stack-trace annotation, outermost first. */
function spanPath(reason: Cause.Reason<unknown>): string | undefined {
  const frame = Context.getOption(Cause.reasonAnnotations(reason), Cause.StackTrace);
  if (Option.isNone(frame)) return undefined;
  const names: string[] = [];
  for (
    let current: typeof frame.value | undefined = frame.value;
    current !== undefined;
    current = current.parent
  ) {
    if (!current.name.endsWith("(definition)") && names.at(-1) !== current.name) {
      names.push(current.name);
    }
  }
  return names.length === 0 ? undefined : names.reverse().join(" > ");
}

/**
 * Renders a failed review for a terminal: the error tag and message, its fields, the
 * `cause` chain, and the span the failure was raised in. Stack traces are left out of
 * typed failures because the span path already locates them.
 */
export function formatReviewFailure(cause: Cause.Cause<unknown>): string {
  const sections: string[] = [];
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      const lines = [`Janitor review failed with ${describe(reason.error)}`];
      lines.push(...fieldLines(reason.error), ...causeLines(reason.error));
      const span = spanPath(reason);
      if (span !== undefined) lines.push(`  span: ${span}`);
      sections.push(lines.join("\n"));
    } else if (Cause.isDieReason(reason)) {
      const defect = reason.defect;
      const lines = [
        `Janitor review failed with an unexpected error: ${describe(defect)}`,
        ...causeLines(defect),
      ];
      const span = spanPath(reason);
      if (span !== undefined) lines.push(`  span: ${span}`);
      if (defect instanceof Error && defect.stack !== undefined) {
        lines.push(`  ${indent(defect.stack, "  ")}`);
      }
      sections.push(lines.join("\n"));
    } else {
      sections.push("Janitor review was interrupted.");
    }
  }
  return sections.length === 0 ? "Janitor review failed." : sections.join("\n\n");
}
