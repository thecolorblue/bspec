import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Fixer, FixInput, FixResult } from "../../src/lib/fix/fixer.ts";
import type { PlannerProvenanceInfo } from "../../src/lib/planner.ts";

/** One scripted edit applied to the temp project before fix() returns. */
export interface FakeEdit {
  /** Path relative to FixInput.cwd. */
  readonly path: string;
  /** New file contents, or null to delete the file (to script reward-hacking). */
  readonly content: string | null;
}

/** A scripted fixer turn: the mutations to apply + the token cost to report. */
export interface FakeFixStep {
  readonly edits: readonly FakeEdit[];
  readonly tokensUsed?: number;
  readonly summary?: string;
}

/**
 * Deterministic `Fixer` test double. Plays one scripted step per `fix()` call
 * (the last repeats), applying file mutations to `FixInput.cwd` so the
 * controller's real gates actually flip. Records every `FixInput` in `.calls`
 * for assertions — mirrors `FakeBlockAuthor`.
 */
export class FakeFixer implements Fixer {
  readonly calls: FixInput[] = [];
  private index = 0;

  constructor(
    private readonly steps: readonly FakeFixStep[],
    private readonly fakeProvenance?: PlannerProvenanceInfo,
  ) {
    if (steps.length === 0) {
      throw new Error("FakeFixer requires at least one scripted step");
    }
  }

  async fix(input: FixInput): Promise<FixResult> {
    this.calls.push(input);
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    this.index += 1;

    for (const edit of step.edits) {
      const abs = join(input.cwd, edit.path);
      if (edit.content === null) {
        await rm(abs, { force: true });
        continue;
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, edit.content);
    }

    return {
      tokensUsed: step.tokensUsed ?? 1000,
      summary: step.summary ?? "(fake) applied scripted edits",
    };
  }

  provenance(): PlannerProvenanceInfo | undefined {
    return this.fakeProvenance;
  }
}
