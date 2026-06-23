import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/lib/fix/ledger.ts";

test("append is immutable and accumulates tokens", () => {
  const a = Ledger.start("/tmp/x", "build", "test");
  const b = a.appendAttempt({
    iter: 1,
    phase: "BUILD",
    signature: "s1",
    strategy: "force-diagnose",
    tokensUsed: 100,
    summary: "did a thing",
  });
  expect(a.state.iterations.length).toBe(0); // original untouched
  expect(b.state.iterations.length).toBe(1);
  expect(b.state.tokensUsed).toBe(100);

  const c = b.appendRejected({
    iter: 2,
    phase: "TEST",
    signature: "s2",
    strategy: "minimal-fix",
    tokensUsed: 50,
    summary: "x",
    violations: ["a.test.ts"],
  });
  expect(c.state.tokensUsed).toBe(150);
  expect(c.state.iterations[1].outcome).toBe("rejected");
});

test("triedSummary lists signatures and flags rejected attempts", () => {
  let l = Ledger.start("/tmp/x", "b", "t");
  expect(l.triedSummary()).toBe("nothing yet");
  l = l.appendAttempt({
    iter: 1,
    phase: "BUILD",
    signature: "aaa",
    strategy: "force-diagnose",
    tokensUsed: 1,
    summary: "",
  });
  l = l.appendRejected({
    iter: 2,
    phase: "TEST",
    signature: "bbb",
    strategy: "minimal-fix",
    tokensUsed: 1,
    summary: "",
    violations: ["x.test.ts"],
  });
  const s = l.triedSummary();
  expect(s).toContain("BUILD:aaa");
  expect(s).toContain("REJECTED(touched x.test.ts)");
});

test("flush writes ledger.json and ledger.md, and load round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bspec-ledger-"));
  try {
    let l = Ledger.start(dir, "npm run build", "npm test");
    l = l.appendAttempt({
      iter: 1,
      phase: "BUILD",
      signature: "sig1",
      strategy: "force-diagnose",
      model: "anthropic/x",
      tokensUsed: 42,
      summary: "fixed an import",
    });
    l = l.escalate("iteration-cap");
    await l.flush();

    const md = await readFile(join(dir, "ledger.md"), "utf8");
    expect(md).toContain("npm run build");
    expect(md).toContain("escalated");
    expect(md).toContain("iteration-cap");
    expect(md).toContain("sig1");

    const loaded = await Ledger.load(dir);
    expect(loaded?.state.iterations.length).toBe(1);
    expect(loaded?.state.status).toBe("escalated");
    expect(loaded?.state.tokensUsed).toBe(42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
