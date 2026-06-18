import { BspecError } from "./errors.ts";
import type { ParamSpec, PlannerOutput } from "./schemas.ts";

/** One installed block as offered to the planner (no embedded file payload). */
export interface BlockMenuEntry {
  id: string;
  version: string;
  summary: string;
  params: Record<string, ParamSpec>;
  produces: string[];
}

/** An answer to a clarifying question, folded into a re-plan round. */
export interface ClarifyingAnswer {
  id: string;
  answer: string;
}

export interface PlannerInput {
  /** Full SPEC.md text. */
  spec: string;
  /** Installed blocks the planner may choose from. */
  menu: BlockMenuEntry[];
  /** Answers to questions raised on a prior round. */
  answers?: ClarifyingAnswer[];
}

/** Plan-level provenance an implementation can report after producing a plan. */
export interface PlannerProvenanceInfo {
  /** The model that produced the plan, as a `provider/id` selector. */
  agent: string;
  /** The Pi SDK version that ran (or another tool version marker). */
  pi_version: string;
}

/**
 * The single AI step in bspec. An implementation turns a spec + block menu into
 * a proposed plan. The real implementation (`PiPlanner`) wraps Pi with tools
 * disabled; tests inject a deterministic `FakePlanner`.
 */
export interface Planner {
  plan(input: PlannerInput): Promise<PlannerOutput>;
  /**
   * Optional: describe what produced the most recent plan. The `plan` command
   * records this in `plan.json.planner`; absent, it falls back to the resolved
   * model selector.
   */
  provenance?(): PlannerProvenanceInfo | undefined;
}

/**
 * Raised when a planner cannot return a usable plan (e.g. the model's output
 * failed validation after the repair budget). Carries the raw model output so
 * `bspec plan` can persist it to `.bspec/logs/plan.log` for later inspection.
 */
export class PlannerError extends BspecError {
  readonly rawOutput?: string;
  readonly attempts?: number;

  constructor(message: string, opts: { rawOutput?: string; attempts?: number } = {}) {
    super(message);
    this.name = "PlannerError";
    this.rawOutput = opts.rawOutput;
    this.attempts = opts.attempts;
  }
}
