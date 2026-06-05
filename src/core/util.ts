/** Small, dependency-free helpers shared across the pipeline. */

/** Lowercase, ASCII-ish slug for ids. Keeps CJK as-is, collapses other runs to "_". */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function capabilityId(name: string): string {
  return `cap.${slugify(name)}`;
}

export function pageId(name: string): string {
  return `page.${slugify(name)}`;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Pull the first JSON value out of an LLM response. Tolerates ```json fences
 * and leading/trailing prose. Returns the parsed value or throws with context.
 */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // Find the first balanced [...] or {...}.
  const start = candidate.search(/[[{]/);
  if (start === -1) {
    throw new Error(`No JSON found in LLM response: ${truncate(text, 200)}`);
  }
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch (e) {
          throw new Error(
            `Malformed JSON in LLM response: ${(e as Error).message}\n${truncate(slice, 400)}`,
          );
        }
      }
    }
  }
  throw new Error(`Unbalanced JSON in LLM response: ${truncate(text, 200)}`);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Split an array into chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
