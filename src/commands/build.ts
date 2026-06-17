import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveBspecHome } from "../config.ts";
import { loadManifest, resolveBlock, runBlock } from "../lib/blocks.ts";
import {
  cacheArchivePath,
  cacheEntryDir,
  cacheMetaPath,
  hasCacheEntry,
} from "../lib/cache.ts";
import { computeCacheKey } from "../lib/cache-key.ts";
import { createTarGz, extractTarGz } from "../lib/archive.ts";
import { BspecError } from "../lib/errors.ts";
import { sha256Hex } from "../lib/hash.ts";
import { stableStringify } from "../lib/json-stable.ts";
import { planSchema, type PlanStep } from "../lib/schemas.ts";

const STATUS_WIDTH = "[replayed]".length;

interface BuildOutputRecord {
  by: string;
  cache: string;
  hash: string;
}

export async function build(opts: { project?: string; home?: string } = {}): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  const project = resolve(opts.project ?? process.cwd());

  const planFile = join(project, ".bspec", "plan.json");
  if (!existsSync(planFile)) {
    throw new BspecError(
      `No plan found at ${planFile}. Create one before running bspec build.`,
    );
  }

  const plan = parsePlan(await readFile(planFile, "utf8"), planFile);

  const distDir = join(project, "dist");
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const logsDir = join(project, ".bspec", "logs");
  await mkdir(logsDir, { recursive: true });

  const outputs: Record<string, BuildOutputRecord> = {};
  let ran = 0;
  let replayed = 0;

  for (const step of plan.steps) {
    if (step.needs.length > 0) {
      throw new BspecError(
        `Dependency graph builds are not supported in v0. Step ${step.id} has non-empty needs.`,
      );
    }

    const blockFile = resolveBlock(step.id, home, step.version);
    const manifest = await loadManifest(blockFile);
    if (manifest.version !== step.version) {
      throw new BspecError(
        `Block ${step.id}@${step.version} was not found in ${home}/blocks. ` +
          `Found version ${manifest.version} instead.`,
      );
    }

    const key = computeCacheKey({
      id: step.id,
      version: step.version,
      params: step.params,
      needsHashes: [],
    });

    const status = hasCacheEntry(key, home)
      ? await replayStep(key, home, distDir, logsDir, step)
      : await runStep(key, home, blockFile, manifest.produces, step, distDir, logsDir);

    if (status === "replayed") replayed++;
    else ran++;

    for (const relPath of manifest.produces) {
      outputs[relPath] = {
        by: `${step.id}@${step.version}`,
        cache: key,
        hash: sha256Hex(await readFile(join(distDir, relPath))),
      };
    }

    const summary = step.summary ?? `Building ${step.id}`;
    process.stdout.write(
      `${summary}... ${step.id}@${step.version} ` +
        `${`[${status}]`.padEnd(STATUS_WIDTH)} -> ${key}\n`,
    );
  }

  await writeFile(
    join(project, ".bspec", "build.json"),
    JSON.stringify({ built_at: new Date().toISOString(), outputs }, null, 2) + "\n",
  );

  const total = plan.steps.length;
  process.stdout.write(
    `Done. ${total} block${total === 1 ? "" : "s"} built ` +
      `(${replayed} replayed, ${ran} ran).\n`,
  );
}

function parsePlan(raw: string, planFile: string) {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BspecError(`Plan at ${planFile} is not valid JSON.`);
  }
  const result = planSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new BspecError(`Invalid plan at ${planFile}: ${first.message}`);
  }
  return result.data;
}

async function runStep(
  key: string,
  home: string,
  blockFile: string,
  produces: string[],
  step: PlanStep,
  distDir: string,
  logsDir: string,
): Promise<"ran"> {
  const staging = await mkdtemp(join(tmpdir(), "bspec-build-"));
  try {
    const paramsFile = join(staging, "__params.json");
    await writeFile(paramsFile, stableStringify(step.params));
    const result = await runBlock(blockFile, ["--apply", staging, paramsFile]);
    await writeFile(
      join(logsDir, `${step.id}.log`),
      `[ran] ${step.id}@${step.version}\nexit=${result.code}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
    );
    if (result.code !== 0) {
      throw new BspecError(
        `Block ${step.id}@${step.version} failed during apply. ` +
          `See ${join(logsDir, `${step.id}.log`)}.`,
      );
    }
    await rm(paramsFile, { force: true });

    // Save outputs to cache, then materialize dist from the cached archive so
    // dist and cache are guaranteed byte-for-byte identical.
    await mkdir(cacheEntryDir(key, home), { recursive: true });
    await createTarGz(staging, produces, cacheArchivePath(key, home));
    await writeFile(
      cacheMetaPath(key, home),
      JSON.stringify(
        {
          block_id: step.id,
          version: step.version,
          params_hash: sha256Hex(stableStringify(step.params)),
          produces,
          cached_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    await extractTarGz(cacheArchivePath(key, home), distDir);
    return "ran";
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function replayStep(
  key: string,
  home: string,
  distDir: string,
  logsDir: string,
  step: PlanStep,
): Promise<"replayed"> {
  await extractTarGz(cacheArchivePath(key, home), distDir);
  await writeFile(
    join(logsDir, `${step.id}.log`),
    `[replayed] ${step.id}@${step.version} from cache ${key}\n`,
  );
  return "replayed";
}
