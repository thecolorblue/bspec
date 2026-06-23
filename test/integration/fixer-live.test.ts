import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotCheckpointer } from "../../src/lib/fix/checkpoint.ts";
import type { ResolvedFixConfig } from "../../src/lib/fix/config.ts";
import { makeGateRunner, runFixLoop } from "../../src/lib/fix/controller.ts";
import { SnapshotDiffGuard } from "../../src/lib/fix/diff-guard.ts";
import { PiFixer } from "../../src/lib/fix/fixer-pi.ts";

/**
 * The single live fixer test: drives a tiny intentionally-broken project to
 * green with the real, tool-enabled PiFixer. Skipped unless BSPEC_LIVE=1 (and
 * Pi is authenticated). Uses bun-native commands so no extra toolchain is
 * needed. Asserts the loop reaches success and the fix went into the
 * implementation, not the protected test.
 */
const LIVE = process.env.BSPEC_LIVE === "1";

const SNAPSHOT_IGNORE = [".git", "node_modules", ".bspec"];

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "bspec-fixer-live-"));
  // Buggy implementation: subtraction where the test expects addition.
  await writeFile(join(project, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  await writeFile(
    join(project, "sum.test.mjs"),
    [
      'import assert from "node:assert";',
      'import { sum } from "./sum.mjs";',
      "assert.strictEqual(sum(2, 3), 5);",
      'console.log("ok");',
      "",
    ].join("\n"),
  );
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

test.skipIf(!LIVE)(
  "PiFixer drives a tiny broken project to green without touching the test",
  async () => {
    const config: ResolvedFixConfig = {
      build: { cmd: "test -f sum.mjs" }, // trivially green; focus is the test phase
      test: { cmd: "bun sum.test.mjs" },
      protected: ["**/*.test.*"],
      maxIters: 6,
      tokenBudget: 2_000_000,
      buildTimeoutMs: 60_000,
      testTimeoutMs: 60_000,
      allowShell: false,
      snapshotIgnore: SNAPSHOT_IGNORE,
    };
    const checkpointer = new SnapshotCheckpointer(
      project,
      join(project, ".bspec", "fix", "snapshots"),
      SNAPSHOT_IGNORE,
    );
    const diffGuard = new SnapshotDiffGuard(checkpointer, SNAPSHOT_IGNORE, config.protected);

    const result = await runFixLoop({
      cwd: project,
      config,
      gates: makeGateRunner(config, project),
      fixer: new PiFixer({ selector: process.env.BSPEC_AGENT }),
      checkpointer,
      diffGuard,
      ledgerDir: join(project, ".bspec", "fix"),
    });

    expect(result.status).toBe("success");
    // The test file is untouched; the implementation was corrected.
    expect(await readFile(join(project, "sum.test.mjs"), "utf8")).toContain("sum(2, 3), 5");
    expect(await readFile(join(project, "sum.mjs"), "utf8")).toContain("a + b");
  },
  240_000,
);
