import { pickDefaultModel, type ModelIdentity } from "../default-model.ts";

export type StrategyName = "force-diagnose" | "minimal-fix" | "fresh-start" | "switch-model";

export interface StrategyRung {
  readonly name: StrategyName;
  /** The per-turn directive injected into the fixer prompt at this rung. */
  readonly directive: string;
  /** Restore the last known-good checkpoint before the next fixer call. */
  readonly restoreCheckpoint: boolean;
  /** Switch to a different model for the next fixer call. */
  readonly switchModel: boolean;
}

/**
 * The escalation ladder (§5.3). Index 0 is the baseline directive used while the
 * loop is still making progress; each later rung is entered only when the stuck
 * detector trips, escalating the response rather than re-running a failed
 * attempt. Past the last rung the controller escalates to a human.
 */
export const LADDER: readonly StrategyRung[] = [
  {
    name: "force-diagnose",
    directive:
      "Before editing anything, state the root cause of this failure in one or two sentences, then make the smallest change that addresses that root cause.",
    restoreCheckpoint: false,
    switchModel: false,
  },
  {
    name: "minimal-fix",
    directive:
      "Earlier attempts did not work. Make the single smallest change that could resolve the current failure; do not refactor or touch unrelated code.",
    restoreCheckpoint: false,
    switchModel: false,
  },
  {
    name: "fresh-start",
    directive:
      "The working tree was reset to the last known-good checkpoint. Abandon the previous approach and try a fundamentally different one.",
    restoreCheckpoint: true,
    switchModel: false,
  },
  {
    name: "switch-model",
    directive:
      "A different model is now taking over. Re-read the failure from scratch and try an approach the previous attempts did not.",
    restoreCheckpoint: false,
    switchModel: true,
  },
];

/** The rung at `index`, clamped to the last rung. */
export function strategyAt(index: number): StrategyRung {
  return LADDER[Math.min(Math.max(index, 0), LADDER.length - 1)];
}

/** True once `index` has advanced past the last rung (→ escalate to human). */
export function isLadderExhausted(index: number): boolean {
  return index >= LADDER.length;
}

/**
 * Choose a model different from the current selector for the switch-model rung,
 * reusing the default-model preference ordering. `excluded` lists selectors the
 * loop has already tried (including any that produced no output), so a dud model
 * is never re-picked. Returns undefined when no untried alternative exists, in
 * which case the controller escalates rather than wastefully re-running a model.
 */
export function pickAlternativeModel<M extends ModelIdentity>(
  currentSelector: string | undefined,
  available: readonly M[],
  excluded: readonly string[] = [],
): M | undefined {
  const skip = new Set([currentSelector, ...excluded].filter(Boolean));
  const others = available.filter((m) => !skip.has(`${m.provider}/${m.id}`));
  if (others.length === 0) return undefined;
  return pickDefaultModel(others);
}
