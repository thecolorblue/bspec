/**
 * Glob matching for the diff-guard. `Bun.Glob` is present at runtime (Bun 1.3.x)
 * with correct `**` semantics, but is missing from the shipped `@types/bun`, so
 * we reach it through a single typed cast isolated here — the rest of the fix
 * modules stay fully type-checked with no `any` or `@ts-expect-error` leakage.
 */
interface GlobMatcher {
  match(path: string): boolean;
}
interface GlobCtor {
  new (pattern: string): GlobMatcher;
}

const Glob = (Bun as unknown as { Glob: GlobCtor }).Glob;

/** True when `path` matches any of the (POSIX-style) glob `patterns`. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Glob(pattern).match(path));
}
