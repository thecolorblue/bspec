import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type IterationOutcome = "attempt" | "rejected";

export interface IterationRecord {
  readonly iter: number;
  readonly phase: string; // "BUILD" | "TEST"
  readonly signature: string;
  readonly strategy: string;
  readonly model?: string;
  readonly tokensUsed: number;
  readonly outcome: IterationOutcome;
  readonly summary: string;
  /** Protected paths the rejected iteration touched (rejected only). */
  readonly violations?: readonly string[];
  readonly checkpointRef?: string;
}

export type RunStatus = "running" | "success" | "escalated";

export interface LedgerState {
  readonly startedAt: string;
  readonly buildCmd: string;
  readonly testCmd: string;
  readonly iterations: readonly IterationRecord[];
  readonly status: RunStatus;
  readonly reason?: string;
  readonly finalRef?: string;
  readonly tokensUsed: number;
}

/** What one `append*` call records (outcome is set by the method). */
type RecordInput = Omit<IterationRecord, "outcome">;

/**
 * The on-disk run state — the loop's "spine". Immutable: every mutator returns a
 * new `Ledger`. `flush()` persists `ledger.json` + a human-readable `ledger.md`
 * (the handoff artifact on escalation) under the given directory.
 */
export class Ledger {
  private constructor(
    readonly state: LedgerState,
    private readonly dir: string,
  ) {}

  static start(dir: string, buildCmd: string, testCmd: string): Ledger {
    return new Ledger(
      {
        startedAt: new Date().toISOString(),
        buildCmd,
        testCmd,
        iterations: [],
        status: "running",
        tokensUsed: 0,
      },
      dir,
    );
  }

  static async load(dir: string): Promise<Ledger | undefined> {
    const file = join(dir, "ledger.json");
    if (!existsSync(file)) return undefined;
    const state = JSON.parse(await readFile(file, "utf8")) as LedgerState;
    return new Ledger(state, dir);
  }

  appendAttempt(record: RecordInput): Ledger {
    return this.append({ ...record, outcome: "attempt" });
  }

  appendRejected(record: RecordInput): Ledger {
    return this.append({ ...record, outcome: "rejected" });
  }

  /** Terminal: mark the run green and record the final checkpoint. */
  succeed(finalRef: string): Ledger {
    return this.with({ status: "success", finalRef });
  }

  /** Terminal: mark the run as needing human handoff, with a reason. */
  escalate(reason: string): Ledger {
    return this.with({ status: "escalated", reason });
  }

  /** Compact, ruled-out list fed to the fixer so it does not repeat itself. */
  triedSummary(): string {
    if (this.state.iterations.length === 0) return "nothing yet";
    return this.state.iterations
      .map((r) => {
        const tag =
          r.outcome === "rejected"
            ? `${r.signature}:REJECTED(touched ${(r.violations ?? []).join(", ")})`
            : r.signature;
        return `${r.phase}:${tag}`;
      })
      .join("; ");
  }

  async flush(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "ledger.json"), `${JSON.stringify(this.state, null, 2)}\n`);
    await writeFile(join(this.dir, "ledger.md"), renderMarkdown(this.state));
  }

  private append(record: IterationRecord): Ledger {
    return this.with({
      iterations: [...this.state.iterations, record],
      tokensUsed: this.state.tokensUsed + record.tokensUsed,
    });
  }

  private with(patch: Partial<LedgerState>): Ledger {
    return new Ledger({ ...this.state, ...patch }, this.dir);
  }
}

function renderMarkdown(state: LedgerState): string {
  const lines: string[] = [
    "# bspec fix — run log",
    "",
    `- Started: ${state.startedAt}`,
    `- Build: \`${state.buildCmd}\``,
    `- Test: \`${state.testCmd}\``,
    `- Status: **${state.status}**${state.reason ? ` (${state.reason})` : ""}`,
    `- Iterations: ${state.iterations.length}`,
    `- Tokens used: ${state.tokensUsed}`,
  ];
  if (state.finalRef) lines.push(`- Final checkpoint: ${state.finalRef}`);
  lines.push("", "## Iterations", "");

  if (state.iterations.length === 0) {
    lines.push("_(none)_");
  } else {
    lines.push(
      "| # | phase | outcome | strategy | model | sig | tokens | note |",
      "|---|-------|---------|----------|-------|-----|--------|------|",
    );
    for (const r of state.iterations) {
      const note =
        r.outcome === "rejected"
          ? `touched ${(r.violations ?? []).join(", ")}`
          : oneLine(r.summary);
      lines.push(
        `| ${r.iter} | ${r.phase} | ${r.outcome} | ${r.strategy} | ${r.model ?? "—"} | \`${r.signature}\` | ${r.tokensUsed} | ${note} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80).replace(/\|/g, "\\|");
}
