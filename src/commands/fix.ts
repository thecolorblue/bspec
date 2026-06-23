import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveBspecHome } from "../config.ts";
import { agentSourceLabel, resolveAgentSelector, type ResolvedAgent } from "../lib/agent.ts";
import type { ModelIdentity } from "../lib/default-model.ts";
import { SnapshotCheckpointer } from "../lib/fix/checkpoint.ts";
import { loadFixConfig, type ResolvedFixConfig } from "../lib/fix/config.ts";
import {
  makeGateRunner,
  runFixLoop,
  type ControllerResult,
} from "../lib/fix/controller.ts";
import { SnapshotDiffGuard } from "../lib/fix/diff-guard.ts";
import { PiFixer } from "../lib/fix/fixer-pi.ts";
import type { Fixer } from "../lib/fix/fixer.ts";
import { loadPi } from "../lib/pi.ts";

export interface FixOptions {
  project?: string;
  home?: string;
  /** `--agent` selector override. */
  agent?: string;
  /** `--build-cmd` / `--test-cmd` overrides (highest precedence over fix.json). */
  buildCmd?: string;
  testCmd?: string;
  /** `--max-iters` / `--token-budget` overrides. */
  maxIters?: number;
  tokenBudget?: number;
  /** Skip the start confirmation (unattended). */
  yes?: boolean;
  /** Injectable fixer (defaults to PiFixer). Tests pass a FakeFixer. */
  fixer?: Fixer;
  /** Injectable model list for the switch-model rung (defaults to Pi's registry). */
  availableModels?: readonly ModelIdentity[];
  /** Injectable line reader for the confirmation prompt (defaults to stdin). */
  ask?: (prompt: string) => Promise<string>;
  /** Injectable per-iteration progress sink (defaults to stdout). */
  onLine?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * `bspec fix` — drive a project's own build and test commands to green by
 * letting a tool-enabled Pi session edit files, under a deterministic
 * controller that owns the stop condition. Generic: it operates on any target
 * project's commands and does not touch bspec's blocks/plans/cache.
 */
export async function fix(opts: FixOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveBspecHome(env);
  const project = resolve(opts.project ?? process.cwd());

  const config = await loadFixConfig(project, {
    buildCmd: opts.buildCmd,
    testCmd: opts.testCmd,
    maxIters: opts.maxIters,
    tokenBudget: opts.tokenBudget,
  });

  const resolved = await resolveAgentSelector({ flag: opts.agent, env, home });

  // Confirm before running arbitrary build/test + AI edits on the host.
  const asker = makeAsker(opts.ask);
  try {
    const approved = opts.yes || (await confirmStart(asker.ask, project, config));
    if (!approved) {
      process.stdout.write("Aborted. No changes made.\n");
      return;
    }
  } finally {
    asker.close();
  }

  // Resolve the fixer + available models. Tests inject the fixer to stay offline;
  // only a real run loads Pi (here for the model list, and per-turn in the fixer).
  let fixer = opts.fixer;
  let availableModels = opts.availableModels ?? [];
  if (!fixer) {
    fixer = new PiFixer({ selector: resolved.selector, onInfo: writeInfo });
    if (!opts.availableModels) availableModels = await loadAvailableModels();
  }

  const fixDir = join(project, ".bspec", "fix");
  const checkpointer = new SnapshotCheckpointer(
    project,
    join(fixDir, "snapshots"),
    config.snapshotIgnore,
  );
  const diffGuard = new SnapshotDiffGuard(checkpointer, config.snapshotIgnore, config.protected);

  process.stdout.write(startBanner(project, config, resolved));

  const result = await runFixLoop({
    cwd: project,
    config,
    gates: makeGateRunner(config, project),
    fixer,
    checkpointer,
    diffGuard,
    ledgerDir: fixDir,
    logsDir: join(fixDir, "logs"),
    availableModels,
    initialModel: resolved.selector,
    onLine: opts.onLine ?? writeInfo,
  });

  process.stdout.write(renderSummary(result, fixDir));
}

/** Best-effort: list models Pi reports as authenticated, for the switch-model rung. */
async function loadAvailableModels(): Promise<ModelIdentity[]> {
  try {
    const pi = await loadPi();
    const registry = pi.ModelRegistry.create(pi.AuthStorage.create());
    return registry.getAvailable().map((m) => ({ provider: m.provider, id: m.id }));
  } catch {
    return []; // a missing/unauthenticated Pi surfaces clearly on the first fix turn
  }
}

async function confirmStart(
  ask: (prompt: string) => Promise<string>,
  project: string,
  config: ResolvedFixConfig,
): Promise<boolean> {
  process.stdout.write(
    [
      "bspec fix repeatedly runs this project's build/test commands and lets an AI edit files in:",
      `  ${project}`,
      `  build: ${config.build.cmd}`,
      `  test:  ${config.test.cmd}`,
      "It snapshots to .bspec/fix and reverts edits to protected files, but it does NOT use git —",
      "run this in a disposable checkout or container. Uncommitted work here may be overwritten.",
      "",
    ].join("\n"),
  );
  const answer = (await ask("Proceed? [y/N] ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function startBanner(
  project: string,
  config: ResolvedFixConfig,
  resolved: ResolvedAgent,
): string {
  const model = resolved.selector
    ? `${resolved.selector} (${agentSourceLabel(resolved.source)})`
    : "Pi's default model";
  return `Fixing ${project}\n  using ${model}; up to ${config.maxIters} iterations.\n`;
}

function renderSummary(result: ControllerResult, fixDir: string): string {
  const { status, reason, ledger } = result;
  const n = ledger.state.iterations.length;
  const iters = `${n} iteration${n === 1 ? "" : "s"}`;
  const tokens = `${ledger.state.tokensUsed} tokens`;
  const ledgerPath = join(fixDir, "ledger.md");

  if (status === "success") {
    return `\nDone — build and tests are green (${iters}, ${tokens}). Log: ${ledgerPath}\n`;
  }
  return (
    `\nEscalated (${reason}) after ${iters}, ${tokens}.\n` +
    `Review the run log and take over: ${ledgerPath}\n`
  );
}

function writeInfo(message: string): void {
  process.stdout.write(`${message}\n`);
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
