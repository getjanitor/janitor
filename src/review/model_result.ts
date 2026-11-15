import { RESERVED_JANITOR_MARKER_PREFIX } from "#/review/markers";

/** Describes why model-authored text is unusable, or returns `undefined` when it is valid. */
export function modelTextProblem(value: string, name: string): string | undefined {
  if (value.trim().length === 0) {
    return `Model review ${name} must not be empty`;
  }
  if (value.includes(RESERVED_JANITOR_MARKER_PREFIX)) {
    return `Model review ${name} contains a reserved Janitor marker. Describe the marker without reproducing its reserved prefix, or escape "<" as "&lt;".`;
  }
  return undefined;
}

/** Throwing form for the agent tools, where pi turns the error into a tool result. */
export function requireValidModelText(value: string, name: string): void {
  const problem = modelTextProblem(value, name);
  if (problem !== undefined) throw new Error(problem);
}
