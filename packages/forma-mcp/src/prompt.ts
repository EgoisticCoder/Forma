// Extracted verbatim from dataset/entries.jsonl. Training rows append two newlines,
// this exact heading, and Python json.dumps(devtools, ensure_ascii=False).
export const USER_PROMPT = "You are a professional UI/UX auditor. Analyze the attached website screenshot and produce a structured audit. First reason about it step by step inside a think block, then output the final JSON report as specified in your instructions.";

// Match Python's default json.dumps separators while retaining Unicode characters.
export function pythonJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(", ")}}`;
}

export function formatTrainingPrompt(devtools: unknown): string {
  return `${USER_PROMPT}\n\nBrowser context (measured, authoritative — trust these over visual estimates):\n${pythonJson(devtools)}`;
}
