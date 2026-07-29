import { RESERVED_JANITOR_MARKER_PREFIX } from "#/review/markers";

export function requireValidModelText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Model review ${name} must not be empty`);
  }
  if (value.includes(RESERVED_JANITOR_MARKER_PREFIX)) {
    throw new Error(
      `Model review ${name} contains a reserved Janitor marker. Describe the marker without reproducing its reserved prefix, or escape "<" as "&lt;".`,
    );
  }
}
