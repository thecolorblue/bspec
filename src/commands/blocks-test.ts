import { resolveBspecHome } from "../config.ts";
import { loadManifest, resolveBlock, runBlock } from "../lib/blocks.ts";
import { BspecError } from "../lib/errors.ts";

export async function blocksTest(
  id: string,
  opts: { home?: string } = {},
): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  const file = resolveBlock(id, home);
  const manifest = await loadManifest(file);

  process.stdout.write(`Testing ${manifest.id}@${manifest.version}... `);
  const result = await runBlock(file, ["--test"]);
  if (result.code !== 0) {
    process.stdout.write("failed\n");
    throw new BspecError(
      `Block ${manifest.id}@${manifest.version} failed its self-test.\n${result.stderr.trim()}`,
    );
  }
  process.stdout.write("ok\n");
}
