import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the bspec home directory.
 * Tests and the manual demo override this via the BSPEC_HOME env var so the
 * real user home is never touched.
 */
export function resolveBspecHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BSPEC_HOME?.trim();
  if (override) return override;
  return join(homedir(), ".bspec");
}

export function blocksDir(home: string = resolveBspecHome()): string {
  return join(home, "blocks");
}

export function cacheDir(home: string = resolveBspecHome()): string {
  return join(home, "cache");
}

export function blockPath(id: string, home: string = resolveBspecHome()): string {
  return join(blocksDir(home), `${id}.block.ts`);
}
