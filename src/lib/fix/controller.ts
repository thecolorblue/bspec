import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelIdentity } from "../default-model.ts";
import type { Checkpointer, CheckpointRef } from "./checkpoint.ts";
import { buildGate, testGate, type GateResult } from "./gates.ts";
import type { ResolvedFixConfig } from "./config.ts";
import { protectedViolations, type DiffGuard } from "./diff-guard.ts";
import type { Fixer, FixPhase } from "./fixer.ts";
import { Ledger } from "./ledger.ts";
import { failureSignature, StuckDetector, trimFailureLog } from "./stuck.ts";
import { isLadderExhausted, LADDER, pickAlternativeModel, strategyAt } from "./strategy.ts";

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

  // Models already used, so switch-model never re-picks one (including a dud that
  // produced no output). Seeded with the initial selector.
  const triedModels = new Set<string>();
  if (model) triedModels.add(model);

  // A record-only baseline snapshot for the human reviewing a run; never used as
  // a revert target (§5.3(b)/#3 — additive build fixes are progress, not noise).
  await checkpointer.snapshot("baseline");
  let lastGreenBuildRef: CheckpointRef | undefined;

  // `attempts` is the budget that matters: only turns that actually changed code
  // count against config.maxIters. No-op and reverted turns escalate strategy but
  // do not consume the budget (#5). `pass` bounds total churn as a safety net.
  let attempts = 0;
  let pass = 0;
  const maxPasses = config.maxIters + LADDER.length + 4;

  /**
   * Climb the escalation ladder one rung (shared by signature-stuck and no-op
   * detection). Returns an escalation result to bubble up, or undefined to keep
   * going on the new rung.
   */
  const climb = async (note: string, exhaustReason: string): Promise<ControllerResult | undefined> => {
    strategyIdx += 1;
    detector = detector.reset();
    if (isLadderExhausted(strategyIdx)) return await escalate(ledger, exhaustReason, onLine);
    const r = strategyAt(strategyIdx);
    onLine(`iter ${pass}: ${note} — escalating to ${r.name}`);
    // #3: only roll back to a *known-good* build. With no green build yet, the
    // accumulated build fixes are progress — keep them instead of reverting.
    if (r.restoreCheckpoint && lastGreenBuildRef !== undefined) {
      await checkpointer.restore(lastGreenBuildRef);
    }
    if (r.switchModel) {
      const next = pickAlternativeModel(model, available, [...triedModels]);
      if (!next) return await escalate(ledger, "stuck-no-alt-model", onLine);
      model = `${next.provider}/${next.id}`;
      triedModels.add(model);
      onLine(`iter ${pass}: switching model to ${model}`);
    }
    return undefined;
  };

  while (attempts < config.maxIters && pass < maxPasses) {
    pass += 1;

    // --- Sequenced gate: build must be green before tests are in scope (§5.1).
    const build = await gates.build();
    let phase: FixPhase;
    let gate: GateResult;
    if (!build.ok) {
      phase = "BUILD";
      gate = build;
    } else {
      if (lastGreenBuildRef === undefined) {
        lastGreenBuildRef = await checkpointer.snapshot(`green-build-${pass}`);
        onLine(`iter ${pass}: build is green — frozen`);
      }
      gate = await gates.test();
      phase = "TEST";
    }
    await writeIterLog(deps, pass, phase, gate);

    // --- Success: build + tests both green.
    if (phase === "TEST" && gate.ok) {
      const finalRef = await checkpointer.snapshot("green");
      ledger = ledger.succeed(finalRef);
      await ledger.flush();
      onLine(`iter ${pass}: tests are green — done`);
      return { status: "success", ledger };
    }

    // --- Signature of the current failure (§5.2).
    const signature = failureSignature(phase, gate.log);
    detector = detector.observe(signature);

    // --- Escalate strategy only when stuck (§5.3) — never re-run an identical attempt.
    if (detector.isStuck()) {
      const esc = await climb(`stuck on ${signature}`, "stuck");
      if (esc) return esc;
    }
    const rung = strategyAt(strategyIdx);

    // --- Checkpoint before the fixer — the diff-guard / revert + no-op target.
    const beforeRef = await checkpointer.snapshot(`pre-iter-${pass}`);

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
    const overBudget = tokensUsed > config.tokenBudget;
    const changed = await diffGuard.changedFiles(cwd, beforeRef);
    const violations = protectedViolations(changed, config.protected);
    const record = {
      iter: pass,
      phase,
      signature,
      strategy: rung.name,
      model,
      tokensUsed: result.tokensUsed,
      summary: result.summary,
      checkpointRef: beforeRef,
    };

    // --- Diff-guard: reject + revert any turn that touched a protected file (§5.5).
    // Not a real attempt; does not consume the budget. A reverted turn is another
    // no-progress observation — escalate only once repeats trip the detector.
    if (violations.length > 0) {
      await checkpointer.restore(beforeRef);
      ledger = ledger.appendRejected({ ...record, violations });
      await ledger.flush();
      onLine(`iter ${pass}: REJECTED — touched ${violations.join(", ")} (reverted)`);
      if (overBudget) return await escalate(ledger, "token-budget", onLine);
      detector = detector.observe(signature);
      if (detector.isStuck()) {
        const esc = await climb("repeated reward-hacking", "stuck");
        if (esc) return esc;
      }
      continue;
    }

    // --- No-op: the turn produced no model output or changed nothing (§5.2/#2/#4).
    // The strongest stuck signal; escalate immediately without burning the budget.
    if (result.tokensUsed === 0 || changed.length === 0) {
      const why = result.tokensUsed === 0 ? "no model output" : "no edits";
      ledger = ledger.appendNoop(record);
      await ledger.flush();
      onLine(`iter ${pass}: NO-OP (${why}) — fixer changed nothing`);
      if (overBudget) return await escalate(ledger, "token-budget", onLine);
      const esc = await climb(`no progress (${why})`, "no-progress");
      if (esc) return esc;
      continue;
    }

    // --- A real attempt: the fixer changed code. This consumes the budget, and
    // counts as progress, so the stuck detector is cleared (#2): a stable-but-
    // advancing signature must not be mistaken for a stall.
    attempts += 1;
    ledger = ledger.appendAttempt(record);
    await ledger.flush();
    detector = detector.reset();
    onLine(`iter ${pass}: ${phase} ${signature} — ${oneLine(result.summary)}`);
    if (overBudget) return await escalate(ledger, "token-budget", onLine);
  }

  // --- Hard exit: real-attempt budget (or the churn safety net) exhausted.
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
