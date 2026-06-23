import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTarGz, extractTarGz } from "../archive.ts";
import { sha256Hex } from "../hash.ts";
import { walk } from "../walk.ts";

/** Opaque reference to a checkpoint (e.g. "snap:pre-iter-3"). */
export type CheckpointRef = string;

export interface Checkpointer {
  snapshot(label: string): Promise<CheckpointRef>;
  restore(ref: CheckpointRef): Promise<void>;
}

/** Lets the diff-guard read the hash manifest captured at a checkpoint. */
export interface ManifestSource {
  manifestFor(ref: CheckpointRef): Promise<Record<string, string>>;
}

interface SnapshotManifest {
  readonly label: string;
  /** relPath → sha256 of content at snapshot time. */
  readonly files: Record<string, string>;
}

/** Hash every (non-ignored) file in the working tree: relPath → sha256. */
export async function hashTree(
  cwd: string,
  ignore: readonly string[],
): Promise<Record<string, string>> {
  const files = await walk(cwd, new Set(ignore));
  const out: Record<string, string> = {};
  for (const rel of files) {
    out[rel] = sha256Hex(await readFile(join(cwd, rel)));
  }
  return out;
}

/**
 * Files-only checkpointer: snapshots the working tree as a tar.gz plus a hash
 * manifest, and restores by overwriting from the tar (recreating deletions,
 * reverting modifications) and removing any files created since the snapshot.
 * It never touches git — branch, history, index, and stashes are left alone.
 */
export class SnapshotCheckpointer implements Checkpointer, ManifestSource {
  constructor(
    private readonly cwd: string,
    /** Where snapshot payloads live, e.g. `<project>/.bspec/fix/snapshots`. */
    private readonly snapshotsDir: string,
    private readonly ignore: readonly string[],
  ) {}

  async snapshot(label: string): Promise<CheckpointRef> {
    const files = await walk(this.cwd, new Set(this.ignore));
    const hashes: Record<string, string> = {};
    for (const rel of files) {
      hashes[rel] = sha256Hex(await readFile(join(this.cwd, rel)));
    }
    const dir = this.dirFor(label);
    await mkdir(dir, { recursive: true });
    const manifest: SnapshotManifest = { label, files: hashes };
    await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await createTarGz(this.cwd, files, join(dir, "tree.tar.gz"));
    return `snap:${label}`;
  }

  async restore(ref: CheckpointRef): Promise<void> {
    const dir = this.dirFor(labelOf(ref));
    const manifest = await this.readManifest(dir);
    const snapped = new Set(Object.keys(manifest.files));

    // Remove files created since the snapshot (absent from the manifest).
    const current = await walk(this.cwd, new Set(this.ignore));
    for (const rel of current) {
      if (!snapped.has(rel)) await rm(join(this.cwd, rel), { force: true });
    }
    // Extract over the tree: overwrites modified files, recreates deleted ones.
    await extractTarGz(join(dir, "tree.tar.gz"), this.cwd);
  }

  async manifestFor(ref: CheckpointRef): Promise<Record<string, string>> {
    const manifest = await this.readManifest(this.dirFor(labelOf(ref)));
    return manifest.files;
  }

  private dirFor(label: string): string {
    return join(this.snapshotsDir, sanitize(label));
  }

  private async readManifest(dir: string): Promise<SnapshotManifest> {
    return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
  }
}

function labelOf(ref: CheckpointRef): string {
  return ref.startsWith("snap:") ? ref.slice("snap:".length) : ref;
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]/g, "_");
}
