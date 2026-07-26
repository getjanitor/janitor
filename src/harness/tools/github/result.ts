export function toolSuccess(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
  };
}
