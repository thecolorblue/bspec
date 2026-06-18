import { listBlockFiles, loadManifest } from "./blocks.ts";
import type { BlockMenuEntry } from "./planner.ts";

/**
 * Build the compact menu the planner picks from: one entry per installed block,
 * carrying only metadata (id, version, summary, param schema, produces) — never
 * the embedded file payloads the block would emit. Reuses the same manifest
 * loader the deterministic build path uses.
 */
export async function buildBlockMenu(home: string): Promise<BlockMenuEntry[]> {
  const files = await listBlockFiles(home);
  const entries: BlockMenuEntry[] = [];
  for (const file of files) {
    const manifest = await loadManifest(file);
    entries.push({
      id: manifest.id,
      version: manifest.version,
      summary: manifest.summary,
      params: manifest.params,
      produces: manifest.produces,
    });
  }
  return entries;
}
