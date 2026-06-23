import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/lib/fix/gates.ts";

test("reports ok and captures stdout for a zero-exit command", async () => {
  const r = await runGate("echo hello", process.cwd(), 5000);
  expect(r.ok).toBe(true);
  expect(r.code).toBe(0);
  expect(r.log).toContain("hello");
  expect(r.timedOut).toBe(false);
});

test("reports failure and captures stderr for a non-zero exit", async () => {
  const r = await runGate("echo oops 1>&2; exit 3", process.cwd(), 5000);
  expect(r.ok).toBe(false);
  expect(r.code).toBe(3);
  expect(r.log).toContain("oops");
});

test("runs in the given cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bspec-gate-"));
  try {
    const r = await runGate("pwd", dir, 5000);
    // macOS tmp is a /var → /private/var symlink, so compare the unique tail.
    const tail = dir.split("/").pop() as string;
    expect(r.log).toContain(tail);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kills a command that exceeds the timeout", async () => {
  const r = await runGate("sleep 5; echo done", process.cwd(), 300);
  expect(r.timedOut).toBe(true);
  expect(r.ok).toBe(false);
  expect(r.log).not.toContain("done");
});
