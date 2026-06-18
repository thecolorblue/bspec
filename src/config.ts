import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BspecError } from "./lib/errors.ts";

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

export function configPath(home: string = resolveBspecHome()): string {
  return join(home, "config.json");
}

/**
 * The bspec config file (`${BSPEC_HOME}/config.json`). It holds only non-secret
 * settings — currently the planner model selector. All model credentials live
 * in Pi (`~/.pi/agent/auth.json` or provider env vars), never here.
 */
export const configSchema = z.object({
  agent: z.string().min(1).optional(),
});
export type BspecConfig = z.infer<typeof configSchema>;

/** Read and validate the config file. A missing file is an empty config. */
export async function loadConfig(home: string = resolveBspecHome()): Promise<BspecConfig> {
  const file = configPath(home);
  if (!existsSync(file)) return {};

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BspecError(`Config at ${file} is not valid JSON.`);
  }

  const result = configSchema.safeParse(json);
  if (!result.success) {
    throw new BspecError(
      `Invalid config at ${file}: ${result.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return result.data;
}
