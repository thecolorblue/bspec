import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotCheckpointer } from "../../src/lib/fix/checkpoint.ts";
import type { ResolvedFixConfig } from "../../src/lib/fix/config.ts";
import {
  makeGateRunner,
  runFixLoop,
  type ControllerDeps,
} from "../../src/lib/fix/controller.ts";
import { SnapshotDiffGuard } from "../../src/lib/fix/diff-guard.ts";
import type { Fixer } from "../../src/lib/fix/fixer.ts";
import type { ModelIdentity } from "../../src/lib/default-model.ts";
import { FakeFixer } from "../helpers/fake-fixer.ts";

let project: string;

const SNAPSHOT_IGNORE = [".git", "node_modules", ".bspec"];

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "bspec-fixloop-"));
  // A baseline file so the first snapshot is never empty.
  await writeFile(join(project, "app.txt"), "v0");
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

/** Gates keyed on sentinel files: build passes once `build.ok` exists, etc. */
function config(over: Partial<ResolvedFixConfig> = {}): ResolvedFixConfig {
  return {
    build: { cmd: "test -f build.ok" },
    test: { cmd: "test -f test.ok" },
    protected: ["**/*.test.*", "tests/**"],
    maxIters: 12,
    tokenBudget: 2_000_000,
    buildTimeoutMs: 5000,
    testTimeoutMs: 5000,
    allowShell: false,
    snapshotIgnore: SNAPSHOT_IGNORE,
    ...over,
  };
}

function makeDeps(
  cfg: ResolvedFixConfig,
  fixer: Fixer,
  availableModels: ModelIdentity[] = [],
): ControllerDeps {
  const snapshotsDir = join(project, ".bspec", "fix", "snapshots");
  const checkpointer = new SnapshotCheckpointer(project, snapshotsDir, cfg.snapshotIgnore);
  const diffGuard = new SnapshotDiffGuard(checkpointer, cfg.snapshotIgnore, cfg.protected);
  return {
    cwd: project,
    config: cfg,
    gates: makeGateRunner(cfg, project),
    fixer,
    checkpointer,
    diffGuard,
    ledgerDir: join(project, ".bspec", "fix"),
    availableModels,
  };
}

test("(a) sequenced build→test reaches green and records success", async () => {
  // Step 1 fixes the build; step 2 fixes the tests.
  const fixer = new FakeFixer([
    { edits: [{ path: "build.ok", content: "" }], summary: "fixed build" },
    { edits: [{ path: "test.ok", content: "" }], summary: "fixed tests" },
  ]);
  const result = await runFixLoop(makeDeps(config(), fixer));

  expect(result.status).toBe("success");
  expect(existsSync(join(project, "build.ok"))).toBe(true);
  expect(existsSync(join(project, "test.ok"))).toBe(true);

  // The build was driven green before the test phase began.
  const phases = result.ledger.state.iterations.map((r) => r.phase);
  expect(phases[0]).toBe("BUILD");
  expect(phases).toContain("TEST");

  // The fixer saw the right phase + gate command each turn.
  expect(fixer.calls[0]?.phase).toBe("BUILD");
  expect(fixer.calls[0]?.gateCommand).toBe("test -f build.ok");
  expect(fixer.calls[1]?.phase).toBe("TEST");

  const md = await readFile(join(project, ".bspec", "fix", "ledger.md"), "utf8");
  expect(md).toContain("Status: **success**");
});

test("(b) an edit to a protected test file is rejected and reverted — no false green", async () => {
  await writeFile(join(project, "app.test.ts"), "ORIGINAL");
  // The fixer creates build.ok (would fix the build) but also tampers with a test.
  const fixer = new FakeFixer([
    {
      edits: [
        { path: "build.ok", content: "" },
        { path: "app.test.ts", content: "HACKED" },
      ],
      summary: "tried to cheat",
    },
  ]);
  const result = await runFixLoop(makeDeps(config({ maxIters: 5 }), fixer));

  expect(result.status).toBe("escalated");
  // The whole iteration was reverted: the protected file is untouched and the
  // smuggled build.ok was rolled back, so the build never falsely went green.
  expect(await readFile(join(project, "app.test.ts"), "utf8")).toBe("ORIGINAL");
  expect(existsSync(join(project, "build.ok"))).toBe(false);
  expect(result.ledger.state.iterations.some((r) => r.outcome === "rejected")).toBe(true);
  expect(result.ledger.state.iterations[0]?.violations).toContain("app.test.ts");
});

test("(c) a no-progress fixer escalates through the ladder to stuck-no-alt-model", async () => {
  // The first turn creates the file; every later turn rewrites identical content,
  // so the diff is empty — a no-op. No-ops escalate the ladder without consuming
  // the attempt budget, and with no alternative model the loop hands off.
  const fixer = new FakeFixer([{ edits: [{ path: "noise.txt", content: "x" }] }]);
  const result = await runFixLoop(makeDeps(config({ maxIters: 15 }), fixer, []));

  expect(result.status).toBe("escalated");
  expect(result.reason).toBe("stuck-no-alt-model");
  // No-op turns are recorded distinctly so the handoff log is legible.
  expect(result.ledger.state.iterations.some((r) => r.outcome === "noop")).toBe(true);
});

test("(c) a turn that makes no edits at all is a no-op, not a real attempt", async () => {
  // Tokens were spent but nothing changed on disk — the strongest stuck signal.
  const fixer = new FakeFixer([{ edits: [], tokensUsed: 500 }]);
  const result = await runFixLoop(makeDeps(config({ maxIters: 15 }), fixer, []));

  expect(result.status).toBe("escalated");
  expect(result.ledger.state.iterations.every((r) => r.outcome === "noop")).toBe(true);
  // None of the no-op turns counted against the iteration budget.
  expect(result.ledger.state.iterations.some((r) => r.outcome === "attempt")).toBe(false);
});

test("(d) the token budget is a hard exit", async () => {
  const fixer = new FakeFixer([{ edits: [{ path: "noise.txt", content: "x" }], tokensUsed: 1000 }]);
  const result = await runFixLoop(makeDeps(config({ tokenBudget: 1500 }), fixer));
  expect(result.status).toBe("escalated");
  expect(result.reason).toBe("token-budget");
});

test("(d) the iteration cap counts only real (code-changing) attempts", async () => {
  // Each step touches a distinct file, so every turn is a real attempt.
  const fixer = new FakeFixer([
    { edits: [{ path: "a.txt", content: "1" }] },
    { edits: [{ path: "b.txt", content: "2" }] },
  ]);
  const result = await runFixLoop(makeDeps(config({ maxIters: 2, tokenBudget: 1_000_000 }), fixer));
  expect(result.status).toBe("escalated");
  expect(result.reason).toBe("iteration-cap");
  const attempts = result.ledger.state.iterations.filter((r) => r.outcome === "attempt");
  expect(attempts.length).toBe(2);
});

test("(f) fresh-start does not revert accumulated fixes when no build is green yet", async () => {
  // Two real, additive edits, then no-ops that climb the ladder into fresh-start.
  // With no green build to roll back to, the accumulated work must survive (#3).
  const fixer = new FakeFixer([
    { edits: [{ path: "keep1.txt", content: "a" }] },
    { edits: [{ path: "keep2.txt", content: "b" }] },
    { edits: [] }, // no-op, repeats — drives the ladder to fresh-start and beyond
  ]);
  const result = await runFixLoop(makeDeps(config({ maxIters: 15 }), fixer, []));

  expect(result.status).toBe("escalated");
  // The additive build fixes were NOT thrown away by the fresh-start restore.
  expect(existsSync(join(project, "keep1.txt"))).toBe(true);
  expect(existsSync(join(project, "keep2.txt"))).toBe(true);
});

test("(g) switch-model picks an untried alternative, then hands off cleanly", async () => {
  const fixer = new FakeFixer([{ edits: [], tokensUsed: 100 }]); // always a no-op
  const models = [
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "anthropic", id: "claude-opus-4-8" },
  ];
  const deps = {
    ...makeDeps(config({ maxIters: 15 }), fixer, models),
    initialModel: "anthropic/claude-haiku-4-5",
  };
  const result = await runFixLoop(deps);

  expect(result.status).toBe("escalated");
  expect(result.reason).toBe("no-progress");
  // The ladder switched to the one untried alternative before giving up.
  expect(result.ledger.state.iterations.some((r) => r.model === "anthropic/claude-opus-4-8")).toBe(
    true,
  );
});

test("(e) when the build never goes green the test gate is never reached", async () => {
  const fixer = new FakeFixer([{ edits: [{ path: "noise.txt", content: "x" }] }]);
  const result = await runFixLoop(makeDeps(config({ maxIters: 3 }), fixer));
  expect(result.status).toBe("escalated");
  expect(result.ledger.state.iterations.every((r) => r.phase === "BUILD")).toBe(true);
});
