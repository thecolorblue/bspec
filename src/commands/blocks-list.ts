import { resolveBspecHome } from "../config.ts";
import { listBlockFiles, loadManifest } from "../lib/blocks.ts";

export async function blocksList(opts: { home?: string } = {}): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  const files = await listBlockFiles(home);

  if (files.length === 0) {
    process.stdout.write("No blocks found. Create one with: bspec blocks add <folder>\n");
    return;
  }

  const rows: Array<{ id: string; version: string; summary: string }> = [];
  for (const file of files) {
    const m = await loadManifest(file);
    rows.push({ id: m.id, version: m.version, summary: m.summary });
  }

  const idW = Math.max(2, ...rows.map((r) => r.id.length));
  const verW = Math.max(7, ...rows.map((r) => r.version.length));
  const header = `${"ID".padEnd(idW)}  ${"VERSION".padEnd(verW)}  SUMMARY`;
  process.stdout.write(header + "\n");
  for (const r of rows) {
    process.stdout.write(
      `${r.id.padEnd(idW)}  ${r.version.padEnd(verW)}  ${r.summary}\n`,
    );
  }
}
