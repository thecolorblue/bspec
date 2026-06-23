import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotCheckpointer } from "../../src/lib/fix/checkpoint.ts";
import {
  diffManifests,
  protectedViolations,
  SnapshotDiffGuard,
} from "../../src/lib/fix/diff-guard.ts";

test("diffManifests reports added, removed, and modified paths", () => {
  const before = { "a.ts": "h1", "b.ts": "h2", "gone.ts": "h3" };
  const after = { "a.ts": "h1", "b.ts": "CHANGED", "new.ts": "h4" };
  expect(diffManifests(before, after)).toEqual(["b.ts", "gone.ts", "new.ts"]);
});

test("protectedViolations keeps only changed paths matching a protected glob", () => {
  const changed = ["src/app.ts", "src/app.test.ts", "tests/e2e.ts"];
  expect(protectedViolations(changed, ["**/*.test.*", "tests/**"])).toEqual([
    "src/app.test.ts",
    "tests/e2e.ts",
  ]);
});

const IGNORE = [".git", "node_modules", ".bspec"];
const PROTECTED = ["**/*.test.*", "tests/**"];

test("SnapshotDiffGuard flags an edit to a protected test file", async () => {
  const project = await mkdtemp(join(tmpdir(), "bspec-guard-"));
  try {
    const cp = new SnapshotCheckpointer(project, join(project, ".bspec", "fix", "snapshots"), IGNORE);
    const guard = new SnapshotDiffGuard(cp, IGNORE, PROTECTED);

    await writeFile(join(project, "app.ts"), "code");
    await writeFile(join(project, "app.test.ts"), "assert(true)");
    const ref = await cp.snapshot("pre-iter-1");

    // A legitimate source edit → no violation.
    await writeFile(join(project, "app.ts"), "better code");
    expect(await guard.changedProtected(project, ref)).toEqual([]);

    // Tampering with the test → flagged.
    await writeFile(join(project, "app.test.ts"), "assert(false) // weakened");
    expect(await guard.changedProtected(project, ref)).toEqual(["app.test.ts"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
