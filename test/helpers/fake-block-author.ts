import type {
  BlockAuthor,
  BlockAuthorInput,
} from "../../src/lib/block-author.ts";
import type { PlannerProvenanceInfo } from "../../src/lib/planner.ts";
import type { BlockAuthorOutput } from "../../src/lib/schemas.ts";

/**
 * Deterministic `BlockAuthor` test double. Returns scripted outputs keyed by the
 * order authoring is requested (the last output repeats), and records every
 * input so tests can assert the gap, taken ids, and taken produces were passed.
 */
export class FakeBlockAuthor implements BlockAuthor {
  private readonly outputs: BlockAuthorOutput[];
  readonly calls: BlockAuthorInput[] = [];
  private index = 0;

  constructor(
    outputs: BlockAuthorOutput | BlockAuthorOutput[],
    private readonly fakeProvenance?: PlannerProvenanceInfo,
  ) {
    this.outputs = Array.isArray(outputs) ? outputs : [outputs];
    if (this.outputs.length === 0) {
      throw new Error("FakeBlockAuthor requires at least one scripted output");
    }
  }

  author(input: BlockAuthorInput): Promise<BlockAuthorOutput> {
    this.calls.push(input);
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)];
    this.index += 1;
    return Promise.resolve(output);
  }

  provenance(): PlannerProvenanceInfo | undefined {
    return this.fakeProvenance;
  }
}
