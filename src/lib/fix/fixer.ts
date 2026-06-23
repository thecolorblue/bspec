import type { PlannerProvenanceInfo } from "../planner.ts";

/** The sequenced gate the fixer is being asked to drive green. */
export type FixPhase = "BUILD" | "TEST";

/** Everything the controller injects into one bounded fixer turn. */
export interface FixInput {
  /** Target project dir; a real fixer binds its file tools to this cwd. */
  readonly cwd: string;
  /** Which gate is currently red (build is always driven green first). */
  readonly phase: FixPhase;
  /** The exact gate command, shown to the agent — it must not run it itself. */
  readonly gateCommand: string;
  /** Trimmed failure output: first failing line + a bounded tail (§5.6). */
  readonly failureLog: string;
  /** Compact ledger of what has already been tried and ruled out. */
  readonly triedSummary: string;
  /** The strategy-ladder directive for this iteration. */
  readonly directive: string;
  /** Globs the fixer must never touch (also enforced by the diff-guard). */
  readonly protectedGlobs: readonly string[];
  /** Resolved model selector for this iteration; undefined → fixer's default. */
  readonly model?: string;
}

/** What one fixer turn reports back. The controller never trusts this for "done". */
export interface FixResult {
  /** Tokens consumed this turn (the controller sums these against the budget). */
  readonly tokensUsed: number;
  /** Final assistant text — for the ledger / human log only, never the gate. */
  readonly summary: string;
}

/**
 * The testability seam (mirrors `BlockAuthor`). The real implementation wraps a
 * tool-enabled Pi session bound to the project; tests inject a `FakeFixer` that
 * applies scripted edits, so the whole controller is exercisable offline.
 */
export interface Fixer {
  fix(input: FixInput): Promise<FixResult>;
  /** Optional: describe the model that ran the most recent fix. */
  provenance?(): PlannerProvenanceInfo | undefined;
}
