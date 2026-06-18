import type {
  Planner,
  PlannerInput,
  PlannerProvenanceInfo,
} from "../../src/lib/planner.ts";
import type { PlannerOutput } from "../../src/lib/schemas.ts";

/**
 * Deterministic `Planner` test double. Returns scripted outputs, one per call
 * (the last output repeats for any further calls), and records the inputs it
 * was given so tests can assert that answers were folded into a re-plan round.
 */
export class FakePlanner implements Planner {
  private readonly outputs: PlannerOutput[];
  readonly calls: PlannerInput[] = [];
  private index = 0;

  constructor(
    outputs: PlannerOutput | PlannerOutput[],
    private readonly fakeProvenance?: PlannerProvenanceInfo,
  ) {
    this.outputs = Array.isArray(outputs) ? outputs : [outputs];
    if (this.outputs.length === 0) {
      throw new Error("FakePlanner requires at least one scripted output");
    }
  }

  plan(input: PlannerInput): Promise<PlannerOutput> {
    this.calls.push(input);
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)];
    this.index += 1;
    return Promise.resolve(output);
  }

  provenance(): PlannerProvenanceInfo | undefined {
    return this.fakeProvenance;
  }
}
