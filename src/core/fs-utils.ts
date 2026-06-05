import fs from "node:fs";
import path from "node:path";

const DEFAULT_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
]);

export interface WalkOptions {
  /** Directory names to skip entirely. */
  skipDirs?: Set<string>;
  /** Only return files whose path matches this predicate. */
  filter?: (absPath: string) => boolean;
  /** Hard cap on files returned (safety against huge repos). */
  limit?: number;
}

/** Recursively list files under `root`, skipping common build/dep dirs. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const skip = opts.skipDirs ?? DEFAULT_SKIP;
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && !e.name.startsWith(".")) stack.push(full);
      } else if (e.isFile()) {
        if (!opts.filter || opts.filter(full)) {
          out.push(full);
          if (opts.limit && out.length >= opts.limit) return out;
        }
      }
    }
  }
  return out;
}

export function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** First existing path among candidates (relative to cwd), or undefined. */
export function firstExistingDir(cwd: string, candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (dirExists(path.join(cwd, c))) return c;
  }
  return undefined;
}
