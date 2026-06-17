import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { walk } from "../lib/walk.ts";
import { BspecError } from "../lib/errors.ts";

export async function preview(
  opts: { project?: string; open?: boolean } = {},
): Promise<void> {
  const project = resolve(opts.project ?? process.cwd());
  const distDir = join(project, "dist");

  if (!existsSync(distDir)) {
    throw new BspecError(
      `No dist/ found at ${distDir}. Run bspec build first.`,
    );
  }

  const rel = relative(process.cwd(), distDir) || ".";
  const display = rel.startsWith("..") ? distDir : `./${rel}`;
  process.stdout.write(`Preview available at ${display}\n`);

  const files = await walk(distDir, new Set([".DS_Store"]));
  process.stdout.write("Files:\n");
  for (const f of files) {
    process.stdout.write(`- ${f}\n`);
  }

  if (opts.open && process.platform === "darwin") {
    spawn("open", [distDir], { stdio: "ignore", detached: true }).unref();
  }
}
