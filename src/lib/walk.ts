import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Directory/file names ignored by default when snapshotting a folder. */
export const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "dist",
  ".bspec",
]);

/**
 * Recursively walk `root`, returning sorted POSIX-style relative paths of every
 * file (not directory). Entries whose name is in the ignore set are skipped at
 * any depth.
 */
export async function walk(
  root: string,
  ignores: Set<string> = DEFAULT_IGNORES,
): Promise<string[]> {
  const out: string[] = [];
  await walkInto(root, root, ignores, out);
  return out.sort();
}

async function walkInto(
  root: string,
  dir: string,
  ignores: Set<string>,
  out: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (ignores.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkInto(root, abs, ignores, out);
    } else if (entry.isFile()) {
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
}
