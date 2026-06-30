import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  folder?: string;
  file?: string;
}

export async function blocksAdd(opts: BlocksAddOptions): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  if (!opts.summary?.trim()) {
    throw new BspecError("A --summary is required to create a block.");
  }

  const folderPath = opts.folder?.trim();
  const filePath = opts.file?.trim();

  if (folderPath && filePath) {
    throw new BspecError("Provide either a folder or --file, not both.");
  }

  if (!folderPath && !filePath) {
    throw new BspecError("A source folder or --file is required to create a block.");
  }

  let sourceLabel: string;
  let produces: string[];
  const files: CapturedFile[] = [];

  if (filePath) {
    const absFile = resolve(filePath);
    if (!existsSync(absFile)) {
      throw new BspecError(`Source file not found: ${filePath}`);
    }
    const stats = await stat(absFile);
    if (!stats.isFile()) {
      throw new BspecError(`--file must point to a file: ${filePath}`);
    }
    const relPath = basename(absFile);
    files.push({ path: relPath, content: await readFile(absFile) });
    produces = [relPath];
    sourceLabel = basename(absFile);
  } else {
    const absDir = resolve(folderPath as string);
    if (!existsSync(absDir)) {
      throw new BspecError(`Source folder not found: ${folderPath}`);
    }
    const stats = await stat(absDir);
    if (!stats.isDirectory()) {
      throw new BspecError(`Source path is not a folder: ${folderPath}`);
    }

    const relPaths = await walk(absDir);
    if (relPaths.length === 0) {
      throw new BspecError(
        `No files found under ${folderPath} (after ignoring junk).`,
      );
    }

    for (const relPath of relPaths) {
      files.push({ path: relPath, content: await readFile(join(absDir, relPath)) });
    }
    produces = relPaths;
    sourceLabel = basename(absDir);
  }

  const id = opts.id?.trim() || slugify(sourceLabel);
  const version = opts.version?.trim() || "0.1.0";

  const source = generateBlockSource(
    { id, version, summary: opts.summary, produces },
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
