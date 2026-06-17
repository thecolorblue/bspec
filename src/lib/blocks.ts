import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { blockPath, blocksDir } from "../config.ts";
import { BspecError } from "./errors.ts";
import { manifestSchema, type Manifest } from "./schemas.ts";

export interface BlockRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a generated block with the given args via `bun <block> ...`. */
export function runBlock(
  blockFile: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<BlockRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [blockFile, ...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/** Resolve a block file path by id, asserting it exists. */
export function resolveBlock(id: string, home: string, version?: string): string {
  const file = blockPath(id, home);
  if (!existsSync(file)) {
    const label = version ? `${id}@${version}` : id;
    throw new BspecError(`Block ${label} was not found in ${blocksDir(home)}.`);
  }
  return file;
}

/** Read and validate a block's manifest by invoking it with `--manifest`. */
export async function loadManifest(blockFile: string): Promise<Manifest> {
  const result = await runBlock(blockFile, ["--manifest"]);
  if (result.code !== 0) {
    throw new BspecError(`Failed to read manifest from ${blockFile}.\n${result.stderr}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new BspecError(`Block ${blockFile} did not print valid JSON for --manifest.`);
  }
  return manifestSchema.parse(parsed);
}

/** List all block files in BSPEC_HOME/blocks. */
export async function listBlockFiles(home: string): Promise<string[]> {
  const dir = blocksDir(home);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  return entries
    .filter((name) => name.endsWith(".block.ts"))
    .map((name) => join(dir, name))
    .sort();
}
