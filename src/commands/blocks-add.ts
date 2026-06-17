import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { blockPath, blocksDir, resolveBspecHome } from "../config.ts";
import {
  generateBlockSource,
  type CapturedFile,
} from "../lib/block-template.ts";
import { BspecError } from "../lib/errors.ts";
import { slugify } from "../lib/slug.ts";
import { walk } from "../lib/walk.ts";

export interface BlocksAddOptions {
  summary: string;
  id?: string;
  version?: string;
  home?: string;
}

export async function blocksAdd(
  folder: string,
  opts: BlocksAddOptions,
): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  const srcDir = resolve(folder);
  if (!existsSync(srcDir)) {
    throw new BspecError(`Source folder not found: ${folder}`);
  }
  if (!opts.summary?.trim()) {
    throw new BspecError("A --summary is required to create a block.");
  }

  const id = opts.id?.trim() || slugify(basename(srcDir));
  const version = opts.version?.trim() || "0.1.0";

  const relPaths = await walk(srcDir);
  if (relPaths.length === 0) {
    throw new BspecError(`No files found under ${folder} (after ignoring junk).`);
  }

  const files: CapturedFile[] = [];
  for (const relPath of relPaths) {
    files.push({ path: relPath, content: await readFile(join(srcDir, relPath)) });
  }

  const source = generateBlockSource(
    { id, version, summary: opts.summary, produces: relPaths },
    files,
  );

  await mkdir(blocksDir(home), { recursive: true });
  const dest = blockPath(id, home);
  await writeFile(dest, source, { mode: 0o755 });

  process.stdout.write(`Created block ${id}@${version}\n`);
  process.stdout.write(`Saved to ${dest}\n`);
  process.stdout.write(`${files.length} files captured\n`);
  process.stdout.write(`Run: bspec blocks test ${id}\n`);
}
