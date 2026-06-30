import { hashTree, type CheckpointRef, type ManifestSource } from "./checkpoint.ts";
import { matchesAnyGlob } from "./glob.ts";

export interface DiffGuard {
  /** All paths the working tree touched since `sinceRef` (empty = no edits). */
  changedFiles(cwd: string, sinceRef: CheckpointRef): Promise<string[]>;
  /** Protected paths the working tree touched since `sinceRef` (empty = clean). */
  changedProtected(cwd: string, sinceRef: CheckpointRef): Promise<string[]>;
}

/**
 * Pure: paths that differ between two snapshot hash-manifests — added (present
 * only in `after`), removed (only in `before`), or modified (hash changed).
 */
export function diffManifests(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [path, hash] of Object.entries(after)) {
    if (before[path] !== hash) changed.add(path); // added or modified
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) changed.add(path); // removed
  }
  return [...changed].sort();
}

/** Pure: of the changed paths, those matching a protected glob. */
export function protectedViolations(
  changed: readonly string[],
  protectedGlobs: readonly string[],
): string[] {
  return changed.filter((path) => matchesAnyGlob(path, protectedGlobs));
}

/**
 * The anti-reward-hacking guard (§5.5). Compares the current working tree to the
 * manifest captured at `sinceRef` and reports any *protected* file the iteration
 * touched. The controller reverts and records a rejection when this is non-empty
 * — the primary, unspoofable defense, since the SDK offers no path-level tool
 * denial. Scoped to a single fixer call's checkpoint so changes are correctly
 * attributed to that one iteration.
 */
export class SnapshotDiffGuard implements DiffGuard {
  constructor(
    private readonly source: ManifestSource,
    private readonly ignore: readonly string[],
    private readonly protectedGlobs: readonly string[],
  ) {}

  async changedFiles(cwd: string, sinceRef: CheckpointRef): Promise<string[]> {
    const before = await this.source.manifestFor(sinceRef);
    const after = await hashTree(cwd, this.ignore);
    return diffManifests(before, after);
  }

  async changedProtected(cwd: string, sinceRef: CheckpointRef): Promise<string[]> {
    return protectedViolations(await this.changedFiles(cwd, sinceRef), this.protectedGlobs);
  }
}
