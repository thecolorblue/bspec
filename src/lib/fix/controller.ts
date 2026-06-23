import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelIdentity } from "../default-model.ts";
import type { Checkpointer, CheckpointRef } from "./checkpoint.ts";
import { buildGate, testGate, type GateResult } from "./gates.ts";
import type { ResolvedFixConfig } from "./config.ts";
import type { DiffGuard } from "./diff-guard.ts";
import type { Fixer, FixPhase } from "./fixer.ts";
import { Ledger } from "./ledger.ts";
import { failureSignature, StuckDetector, trimFailureLog } from "./stuck.ts";
import { isLadderExhausted, pickAlternativeModel, strategyAt } from "./strategy.ts";

/** Runs the two sequenced gates. Injectable so the controller is unit-testable. */
export interface GateRunner {
  build(): Promise<GateResult>;
  test(): Promise<GateResult>;
}

/** Wrap the real shell gates for a project + config. */
export function makeGateRunner(config: ResolvedFixConfig, cwd: string): GateRunner {
  return {
    build: () => buildGate(config, cwd),
    test: () => testGate(config, cwd),
  };
}

export interface ControllerDeps {
  readonly cwd: string;
  readonly config: ResolvedFixConfig;
  readonly gates: GateRunner;
  readonly fixer: Fixer;
  readonly checkpointer: Checkpointer;
  readonly diffGuard: DiffGuard;
  /** Where the ledger (ledger.json / ledger.md) is written. */
  readonly ledgerDir: string;
  /** Where per-iteration gate logs are written (optional). */
  readonly logsDir?: string;
  /** Models the switch-model rung may pick from (from the Pi registry). */
  readonly availableModels?: readonly ModelIdentity[];
  /** Initial model selector; undefined → the fixer's own default. */
  readonly initialModel?: string;
  /** Per-iteration progress sink (defaults to no-op). */
  readonly onLine?: (line: string) => void;
}

export interface ControllerResult {
  readonly status: "success" | "escalated";
  readonly reason?: string;
  readonly ledger: Ledger;
}

/**
 * The outer controller — `D(C(B(A)))`. Owns the stop condition (deterministic
 * gate exit codes), sequences build→test, detects stalls and escalates strategy,
 * reverts reward-hacking via the diff-guard, and enforces iteration + token
 * budgets. The injected `fixer` only proposes edits; it never decides "done".
 */
export async function runFixLoop(deps: ControllerDeps): Promise<ControllerResult> {
  const { cwd, config, gates, fixer, checkpointer, diffGuard } = deps;
  const onLine = deps.onLine ?? (() => {});
  const available = deps.availableModels ?? [];

  let ledger = Ledger.start(deps.ledgerDir, config.build.cmd, config.test.cmd);
  let detector = StuckDetector.empty();
  let strategyIdx = 0;
  let model = deps.initialModel;
  let tokensUsed = 0;

  const baselineRef = await checkpointer.snapshot("baseline");
  let lastGreenBuildRef: CheckpointRef | undefined;

  for (let iter = 1; iter <= config.maxIters; iter++) {
    // --- Sequenced gate: build must be green before tests are in scope (§5.1).
    const build = await gates.build();
    let phase: FixPhase;
    let gate: GateResult;
    if (!build.ok) {
      phase = "BUILD";
      gate = build;
    } else {
      if (lastGreenBuildRef === undefined) {
        lastGreenBuildRef = await checkpointer.snapshot(`green-build-${iter}`);
        onLine(`iter ${iter}: build is green — frozen`);
      }
      gate = await gates.test();
      phase = "TEST";
    }
    await writeIterLog(deps, iter, phase, gate);

    // --- Success: build + tests both green.
    if (phase === "TEST" && gate.ok) {
      const finalRef = await checkpointer.snapshot("green");
      ledger = ledger.succeed(finalRef);
      await ledger.flush();
      onLine(`iter ${iter}: tests are green — done`);
      return { status: "success", ledger };
    }

    // --- Signature of the current failure (§5.2).
    const signature = failureSignature(phase, gate.log);
    detector = detector.observe(signature);

    // --- Escalate strategy only when stuck (§5.3) — never re-run an identical attempt.
    if (detector.isStuck()) {
      strategyIdx += 1;
      detector = detector.reset();
      if (isLadderExhausted(strategyIdx)) {
        return await escalate(ledger, "stuck", onLine);
      }
      const rung = strategyAt(strategyIdx);
      onLine(`iter ${iter}: stuck on ${signature} — escalating to ${rung.name}`);
      if (rung.restoreCheckpoint) {
        await checkpointer.restore(lastGreenBuildRef ?? baselineRef);
      }
      if (rung.switchModel) {
        const next = pickAlternativeModel(model, available);
        if (!next) return await escalate(ledger, "stuck-no-alt-model", onLine);
        model = `${next.provider}/${next.id}`;
        onLine(`iter ${iter}: switching model to ${model}`);
      }
    }
    const rung = strategyAt(strategyIdx);

    // --- Checkpoint before the fixer — the diff-guard / revert target.
    const beforeRef = await checkpointer.snapshot(`pre-iter-${iter}`);

    // --- One bounded fixer turn.
    const result = await fixer.fix({
      cwd,
      phase,
      gateCommand: phase === "BUILD" ? config.build.cmd : config.test.cmd,
      failureLog: trimFailureLog(gate.log),
      triedSummary: ledger.triedSummary(),
      directive: rung.directive,
      protectedGlobs: config.protected,
      model,
    });
    tokensUsed += result.tokensUsed;

    // --- Diff-guard: reject + revert any iteration that touched a protected file (§5.5).
    const violations = await diffGuard.changedProtected(cwd, beforeRef);
    if (violations.length > 0) {
      await checkpointer.restore(beforeRef);
      ledger = ledger.appendRejected({
        iter,
        phase,
        signature,
        strategy: rung.name,
        model,
        tokensUsed: result.tokensUsed,
        summary: result.summary,
        violations,
        checkpointRef: beforeRef,
      });
      detector = detector.observe(signature); // a reverted attempt = no progress
      onLine(`iter ${iter}: REJECTED — touched ${violations.join(", ")} (reverted)`);
    } else {
      ledger = ledger.appendAttempt({
        iter,
        phase,
        signature,
        strategy: rung.name,
        model,
        tokensUsed: result.tokensUsed,
        summary: result.summary,
        checkpointRef: beforeRef,
      });
      onLine(`iter ${iter}: ${phase} ${signature} — ${oneLine(result.summary)}`);
    }
    await ledger.flush();

    // --- Hard exit: token budget.
    if (tokensUsed > config.tokenBudget) {
      return await escalate(ledger, "token-budget", onLine);
    }
  }

  // --- Hard exit: iteration cap.
  return await escalate(ledger, "iteration-cap", onLine);
}

async function escalate(
  ledger: Ledger,
  reason: string,
  onLine: (line: string) => void,
): Promise<ControllerResult> {
  const escalated = ledger.escalate(reason);
  await escalated.flush();
  onLine(`escalated: ${reason}`);
  return { status: "escalated", reason, ledger: escalated };
}

async function writeIterLog(
  deps: ControllerDeps,
  iter: number,
  phase: string,
  gate: GateResult,
): Promise<void> {
  if (!deps.logsDir) return;
  await mkdir(deps.logsDir, { recursive: true });
  const header = `# ${phase} — exit ${gate.code}${gate.timedOut ? " (timed out)" : ""}, ${Math.round(gate.durationMs)}ms\n`;
  await writeFile(join(deps.logsDir, `iter-${iter}.log`), header + gate.log);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 100);
}
