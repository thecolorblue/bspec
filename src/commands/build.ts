import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { performance } from "node:perf_hooks";
import { resolveBspecHome } from "../config.ts";
import { agentSourceLabel, resolveAgentSelector } from "../lib/agent.ts";
import {
  BlockAuthorError,
  installAuthoredBlock,
  validateAuthoredBlock,
  type BlockAuthor,
} from "../lib/block-author.ts";
import { PiBlockAuthor } from "../lib/block-author-pi.ts";
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
import { buildBlockMenu } from "../lib/menu.ts";
import {
  cacheMetaSchema,
  type Manifest,
  planSchema,
  type Plan,
  type PlanGap,
  type PlanStep,
} from "../lib/schemas.ts";
import { BuildTodoTracker } from "../lib/build-todo.ts";

const STATUS_WIDTH = "[replayed]".length;

interface BuildOutputRecord {
  by: string;
  cache: string;
  hash: string;
}

export interface BuildOptions {
  project?: string;
  home?: string;
  /** `--agent` selector override for authoring gap blocks. */
  agent?: string;
  /** Skip the approval prompt and author gap blocks non-interactively. */
  yes?: boolean;
  /** Build only the steps already in the plan; never author gap blocks. */
  noAuthor?: boolean;
  /** Injectable author (defaults to `PiBlockAuthor` when authoring runs). */
  author?: BlockAuthor;
  /** Injectable line reader for the approval prompt (defaults to stdin readline). */
  ask?: (prompt: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

/** A plan step resolved to its block file, declared outputs, and cache key. */
interface ResolvedStep {
  step: PlanStep;
  blockFile: string;
  manifest: Manifest;
  produces: string[];
  key: string;
}

/**
 * Mutable accumulator threaded through the build phases. Tracks the outputs map
 * written to build.json, the ran/replayed counts, and the ids + output paths
 * claimed so far (so a later authored block never reuses one).
 */
interface BuildState {
  home: string;
  distDir: string;
  logsDir: string;
  outputs: Record<string, BuildOutputRecord>;
  ran: number;
  replayed: number;
  /** Every output path produced so far — seeds `takenProduces` for authoring. */
  produced: Set<string>;
  /** Every step id built so far — seeds `takenIds` for authoring. */
  takenIds: Set<string>;
  todo?: BuildTodoTracker;
}

export async function build(opts: BuildOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveBspecHome(env);
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

  const todo = await BuildTodoTracker.create();

  const state: BuildState = {
    home,
    distDir,
    logsDir,
    outputs: {},
    ran: 0,
    replayed: 0,
    produced: new Set(),
    takenIds: new Set(),
    todo,
  };

  try {
    state.todo?.seedGaps(plan.gaps);

    // Phase 1: drop every already-cached block into the project right away, and
    // say what was added. The remaining (uncached) planned steps come back to run.
    const pending = await replayCachedSteps(state, plan.steps);

    // Phase 2: run the planned blocks that have no cache entry yet.
    await runPendingSteps(state, pending);

    // Phase 3: author each gap, then build + cache it in place. When there are no
    // gaps this is skipped and the build stays fully offline.
    let steps = plan.steps;
    let remainingGaps = plan.gaps;
    if (plan.gaps.length > 0 && !opts.noAuthor) {
      const authored = await authorAndBuildGaps(
        plan,
        {
          project,
          home,
          env,
          agent: opts.agent,
          yes: opts.yes ?? false,
          ask: opts.ask,
          author: opts.author,
        },
        state,
      );
      steps = authored.steps;
      remainingGaps = authored.gaps;
      if (authored.changed) {
        await writeUpdatedPlan(planFile, plan, steps, remainingGaps);
      }
    } else if (plan.gaps.length > 0 && opts.noAuthor) {
      printSkippedGaps(plan.gaps, "authoring is off (--no-author)");
    }

    await writeFile(
      join(project, ".bspec", "build.json"),
      JSON.stringify({ built_at: new Date().toISOString(), outputs: state.outputs }, null, 2) + "\n",
    );

    const total = state.ran + state.replayed;
    process.stdout.write(
      `Done. ${total} block${total === 1 ? "" : "s"} built ` +
        `(${state.replayed} replayed, ${state.ran} ran).\n`,
    );

    if (remainingGaps.length > 0) {
      const n = remainingGaps.length;
      process.stdout.write(
        `Note: ${n} feature${n === 1 ? "" : "s"} still ` +
          `${n === 1 ? "has" : "have"} no block. Re-run to retry, or add a block manually.\n`,
      );
    }
  } finally {
    todo.dispose();
  }
}

/** Resolve a step to its block file, declared outputs, and cache key. */
async function resolveStep(step: PlanStep, home: string): Promise<ResolvedStep> {
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

  let produces = manifest.produces;
  const metaFile = cacheMetaPath(key, home);
  if (existsSync(metaFile)) {
    try {
      const parsed = cacheMetaSchema.parse(JSON.parse(await readFile(metaFile, "utf8")));
      if (Array.isArray(parsed.produces) && parsed.produces.length > 0) {
        produces = parsed.produces;
      }
    } catch {
      // Fall back to manifest-declared produces when cache metadata is missing or invalid.
    }
  }

  return { step, blockFile, manifest, produces, key };
}

/**
 * Phase 1. Materialize every planned step that already has a cache entry into the
 * project immediately, announcing the batch up front. Returns the planned steps
 * that still need to run (their block exists but their output is not cached).
 */
async function replayCachedSteps(state: BuildState, steps: PlanStep[]): Promise<ResolvedStep[]> {
  const cached: ResolvedStep[] = [];
  const pending: ResolvedStep[] = [];
  for (const step of steps) {
    const resolved = await resolveStep(step, state.home);
    const hasCache = hasCacheEntry(resolved.key, state.home);
    state.todo?.ensureStepTask(resolved.step, {
      initialStatus: hasCache ? "completed" : "pending",
      silent: true,
    });
    if (hasCache) cached.push(resolved);
    else pending.push(resolved);
  }

  state.todo?.render(true);

  if (cached.length > 0) {
    const n = cached.length;
    process.stdout.write(
      `Adding ${n} cached block${n === 1 ? "" : "s"} to the project:\n`,
    );
    for (const resolved of cached) {
      await replayStep(resolved.key, state.home, state.distDir, state.logsDir, resolved.step);
      await recordAndReport(state, resolved, "replayed");
    }
  }

  return pending;
}

/** Phase 2. Run each planned-but-uncached block into the project and cache it. */
async function runPendingSteps(state: BuildState, pending: ResolvedStep[]): Promise<void> {
  for (const resolved of pending) {
    state.todo?.markStepInProgress(resolved.step);
    const actual = await runStep(state, resolved);
    resolved.produces = actual;
    await recordAndReport(state, resolved, "ran");
  }
}

/** Fold a built step's outputs into build.json, bump counts, and print its line. */
async function recordAndReport(
  state: BuildState,
  resolved: ResolvedStep,
  status: "ran" | "replayed",
): Promise<void> {
  if (status === "replayed") state.replayed++;
  else state.ran++;

  for (const relPath of resolved.produces) {
    state.outputs[relPath] = {
      by: `${resolved.step.id}@${resolved.step.version}`,
      cache: resolved.key,
      hash: sha256Hex(await readFile(join(state.distDir, relPath))),
    };
    state.produced.add(relPath);
  }
  state.takenIds.add(resolved.step.id);

  state.todo?.markStepCompleted(resolved.step, { silent: status === "replayed" });

  const summary = resolved.step.summary ?? `Building ${resolved.step.id}`;
  process.stdout.write(
    `${summary}... ${resolved.step.id}@${resolved.step.version} ` +
      `${`[${status}]`.padEnd(STATUS_WIDTH)} -> ${resolved.key}\n`,
  );
}

interface AuthorContext {
  project: string;
  home: string;
  env: NodeJS.ProcessEnv;
  agent?: string;
  yes: boolean;
  ask?: (prompt: string) => Promise<string>;
  author?: BlockAuthor;
}

interface AuthorResult {
  steps: PlanStep[];
  gaps: PlanGap[];
  /** True when at least one block was authored (so plan.json should be rewritten). */
  changed: boolean;
}

/**
 * Phase 3. Turn each gap into an authored block and build it in place — guarded
 * by approval. Per gap, in order: author, validate, install for reuse, build into
 * the project, and cache. The AI runs only on this first build; afterwards the
 * gaps are gone, the blocks are installed, and their outputs are cached, so
 * rebuilds replay deterministically in Phase 1.
 */
async function authorAndBuildGaps(
  plan: Plan,
  ctx: AuthorContext,
  state: BuildState,
): Promise<AuthorResult> {
  const unchanged: AuthorResult = { steps: plan.steps, gaps: plan.gaps, changed: false };

  const interactive = !ctx.yes && (ctx.ask !== undefined || (process.stdin.isTTY ?? false));
  if (!ctx.yes && !interactive) {
    printSkippedGaps(plan.gaps, "re-run with --yes, or interactively, to author them");
    return unchanged;
  }

  printGapsToAuthor(plan.gaps);
  const asker = makeAsker(ctx.ask);
  try {
    const approved = ctx.yes || (await confirmAuthor(asker.ask));
    if (!approved) {
      process.stdout.write("Skipping block authoring. Gaps left in the plan.\n");
      return unchanged;
    }

    const resolved = await resolveAgentSelector({ flag: ctx.agent, env: ctx.env, home: ctx.home });
    const n = plan.gaps.length;
    const header = resolved.selector
      ? `Authoring + building ${n} block${n === 1 ? "" : "s"} using ${resolved.selector} ` +
        `(${agentSourceLabel(resolved.source)})…`
      : `Authoring + building ${n} block${n === 1 ? "" : "s"} using Pi's default model…`;
    process.stdout.write(header + "\n");

    const author =
      ctx.author ?? new PiBlockAuthor({ selector: resolved.selector, onInfo: writeInfo });
    const spec = await readSpec(ctx.project);
    return await runAuthorRounds(plan, author, spec, state);
  } finally {
    asker.close();
  }
}

/**
 * Author every gap in order. Each authored block is validated, installed, then
 * built into the project and cached before moving on — so its outputs (and the
 * ids/paths it claims) are visible to the next gap.
 */
async function runAuthorRounds(
  plan: Plan,
  author: BlockAuthor,
  spec: string,
  state: BuildState,
): Promise<AuthorResult> {
  // An authored id must not collide with any installed block, even one not in
  // the plan — installing would silently overwrite it. Seed from the full menu.
  const installedIds = (await buildBlockMenu(state.home)).map((e) => e.id);

  const steps: PlanStep[] = [...plan.steps];
  const remainingGaps: PlanGap[] = [];
  let changed = false;

  for (const [index, gap] of plan.gaps.entries()) {
    const startedAt = performance.now();
    const startedIso = new Date().toISOString();
    const input = {
      gap,
      spec,
      takenIds: [...new Set([...installedIds, ...state.takenIds])],
      takenProduces: [...state.produced],
    };
    try {
      state.todo?.markGapInProgress(index);
      const output = await author.author(input);
      const authorDurationMs = performance.now() - startedAt;
      const validation = await validateAuthoredBlock(output, input);
      if (!validation.ok) {
        process.stdout.write(
          `  ! Could not author "${gap.feature}": ${validation.message} ` +
            `[started ${startedIso}, took ${formatDuration(authorDurationMs)}]\n`,
        );
        state.todo?.markGapPending(index, { silent: true });
        remainingGaps.push(gap);
        continue;
      }

      // Install the validated block, then build it into the project right away.
      await installAuthoredBlock(validation.source, validation.step.id, state.home);
      state.todo?.promoteGapToStep(index, validation.step);
      state.todo?.markStepInProgress(validation.step);
      process.stdout.write(
        `  + Authored ${validation.step.id}@${validation.step.version} for "${gap.feature}" ` +
          `[started ${startedIso}, took ${formatDuration(authorDurationMs)}] — building…\n`,
      );
      const resolved = await resolveStep(validation.step, state.home);
      const actual = await runStep(state, resolved);
      resolved.produces = actual;
      await recordAndReport(state, resolved, "ran");

      steps.push(validation.step);
      changed = true;
    } catch (err) {
      if (err instanceof BlockAuthorError) {
        const durationMs = performance.now() - startedAt;
        const attemptsLabel = err.attempts ?? "unknown";
        process.stdout.write(
          `  ! Could not author "${gap.feature}": ${err.message} ` +
            `[started ${startedIso}, took ${formatDuration(durationMs)}, attempts=${attemptsLabel}]\n`,
        );
        state.todo?.markGapPending(index, { silent: true });
        remainingGaps.push(gap);
        continue;
      }
      throw err;
    }
  }

  return { steps, gaps: remainingGaps, changed };
}

/** Rewrite plan.json with newly authored steps folded in and gaps reduced. */
async function writeUpdatedPlan(
  planFile: string,
  plan: Plan,
  steps: PlanStep[],
  gaps: PlanGap[],
): Promise<void> {
  const updated = {
    ...(plan.spec_hash !== undefined ? { spec_hash: plan.spec_hash } : {}),
    steps,
    gaps,
    ...(plan.planner !== undefined ? { planner: plan.planner } : {}),
  };
  await writeFile(planFile, JSON.stringify(updated, null, 2) + "\n");
}

function printGapsToAuthor(gaps: PlanGap[]): void {
  const n = gaps.length;
  process.stdout.write(
    `\n${n} feature${n === 1 ? "" : "s"} in the plan ${n === 1 ? "has" : "have"} no block yet. ` +
      `I can author ${n === 1 ? "it as a new block" : "them as new blocks"}:\n`,
  );
  for (const gap of gaps) {
    process.stdout.write(`  - ${gap.feature} — ${gap.reason}\n`);
  }
  process.stdout.write("\n");
}

function printSkippedGaps(gaps: PlanGap[], hint: string): void {
  const n = gaps.length;
  process.stdout.write(
    `\n${n} feature${n === 1 ? "" : "s"} in the plan ${n === 1 ? "has" : "have"} no block (${hint}):\n`,
  );
  for (const gap of gaps) {
    process.stdout.write(`  - ${gap.feature}\n`);
  }
  process.stdout.write("\n");
}

async function confirmAuthor(ask: (prompt: string) => Promise<string>): Promise<boolean> {
  const answer = (await ask("Author + build these? [y/N] ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function readSpec(project: string): Promise<string> {
  const file = join(project, "SPEC.md");
  if (!existsSync(file)) return "";
  return readFile(file, "utf8");
}

function writeInfo(message: string): void {
  process.stdout.write(message + "\n");
}

/** A reusable line reader. Tests inject `ask`; real runs use one stdin readline. */
function makeAsker(injected?: (prompt: string) => Promise<string>): {
  ask: (prompt: string) => Promise<string>;
  close: () => void;
} {
  if (injected) return { ask: injected, close: () => {} };

  let rl: ReturnType<typeof createInterface> | undefined;
  return {
    ask: async (prompt: string) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return (await rl.question(prompt)).trim();
    },
    close: () => rl?.close(),
  };
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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(0)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

async function runStep(state: BuildState, resolved: ResolvedStep): Promise<string[]> {
  const staging = await mkdtemp(join(tmpdir(), "bspec-build-"));
  try {
    const paramsFile = join(staging, "__params.json");
    await writeFile(paramsFile, stableStringify(resolved.step.params));
    const result = await runBlock(resolved.blockFile, ["--apply", staging, paramsFile]);
    await writeFile(
      join(state.logsDir, `${resolved.step.id}.log`),
      `[ran] ${resolved.step.id}@${resolved.step.version}\nexit=${result.code}\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
    );
    if (result.code !== 0) {
      throw new BspecError(
        `Block ${resolved.step.id}@${resolved.step.version} failed during apply. ` +
          `See ${join(state.logsDir, `${resolved.step.id}.log`)}.`,
      );
    }
    await rm(paramsFile, { force: true });

    const actualProduces = resolveProducedPaths(
      staging,
      resolved.manifest,
      resolved.step.params,
    );

    // Save outputs to cache, then materialize dist from the cached archive so
    // dist and cache are guaranteed byte-for-byte identical.
    await mkdir(cacheEntryDir(resolved.key, state.home), { recursive: true });
    await createTarGz(staging, actualProduces, cacheArchivePath(resolved.key, state.home));
    await writeFile(
      cacheMetaPath(resolved.key, state.home),
      JSON.stringify(
        {
          block_id: resolved.step.id,
          version: resolved.step.version,
          params_hash: sha256Hex(stableStringify(resolved.step.params)),
          produces: actualProduces,
          cached_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    await extractTarGz(cacheArchivePath(resolved.key, state.home), state.distDir);
    return actualProduces;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function resolveProducedPaths(
  stagingDir: string,
  manifest: Manifest,
  params: Record<string, unknown>,
): string[] {
  const resolved: string[] = [];
  for (const declared of manifest.produces) {
    const candidates = candidatePaths(declared, manifest, params);
    const found = candidates.find((candidate) => existsSync(join(stagingDir, candidate)));
    if (!found) {
      throw new BspecError(
        `Block ${manifest.id}@${manifest.version} declared it produces "${declared}", ` +
          "but the file was not written during apply.",
      );
    }
    resolved.push(found);
  }
  return [...new Set(resolved)];
}

function candidatePaths(
  declared: string,
  manifest: Manifest,
  params: Record<string, unknown>,
): string[] {
  const candidates = new Set<string>([declared]);
  if (manifest.params) {
    for (const [name, spec] of Object.entries(manifest.params)) {
      const defaultValue = spec?.default;
      const actualValue = params[name];
      if (
        typeof defaultValue === "string" &&
        defaultValue.length > 0 &&
        typeof actualValue === "string" &&
        actualValue.length > 0 &&
        actualValue !== defaultValue
      ) {
        const escaped = escapeRegExp(defaultValue);
        const pattern = new RegExp(escaped, "g");
        for (const existing of Array.from(candidates)) {
          if (existing.includes(defaultValue)) {
            candidates.add(existing.replace(pattern, actualValue));
          }
        }
      }
    }
  }
  return Array.from(candidates);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
