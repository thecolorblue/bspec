import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fix } from "../../src/commands/fix.ts";
import { FakeFixer } from "../helpers/fake-fixer.ts";

let home: string;
let project: string;

async function capture(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

function scriptedAsk(responses: string[]): (prompt: string) => Promise<string> {
  let i = 0;
  return () => Promise.resolve(responses[i++] ?? "");
}

async function writeFixJson(): Promise<void> {
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(
    join(project, ".bspec", "fix.json"),
    JSON.stringify({ build: { cmd: "test -f build.ok" }, test: { cmd: "test -f test.ok" } }),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-fix-home-"));
  project = await mkdtemp(join(tmpdir(), "bspec-fix-project-"));
  await writeFile(join(project, "app.txt"), "v0"); // non-empty baseline
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test("fix runs the loop to green with --yes and writes a ledger", async () => {
  await writeFixJson();
  const fixer = new FakeFixer([
    { edits: [{ path: "build.ok", content: "" }], summary: "fixed build" },
    { edits: [{ path: "test.ok", content: "" }], summary: "fixed tests" },
  ]);

  const out = await capture(() => fix({ project, home, env: {}, fixer, yes: true }));

  expect(out).toContain("Done — build and tests are green");
  expect(existsSync(join(project, "build.ok"))).toBe(true);
  expect(existsSync(join(project, "test.ok"))).toBe(true);
  expect(existsSync(join(project, ".bspec", "fix", "ledger.md"))).toBe(true);

  // The fixer was driven build-first, then test.
  expect(fixer.calls[0]?.phase).toBe("BUILD");
  expect(fixer.calls[1]?.phase).toBe("TEST");
});

test("the start confirmation gates the run: a 'no' answer makes no changes", async () => {
  await writeFixJson();
  const fixer = new FakeFixer([{ edits: [{ path: "build.ok", content: "" }] }]);

  const out = await capture(() =>
    fix({ project, home, env: {}, fixer, ask: scriptedAsk(["n"]) }),
  );

  expect(out).toContain("Aborted");
  expect(fixer.calls.length).toBe(0);
  expect(existsSync(join(project, "build.ok"))).toBe(false);
});

test("a missing build/test command is a clear error", async () => {
  // No fix.json and no SPEC.md → required commands are absent.
  const fixer = new FakeFixer([{ edits: [] }]);
  await expect(fix({ project, home, env: {}, fixer, yes: true })).rejects.toThrow(
    /No build command/,
  );
});

test("CLI flags override the absent fix.json so the loop can still run", async () => {
  const fixer = new FakeFixer([
    { edits: [{ path: "build.ok", content: "" }] },
    { edits: [{ path: "test.ok", content: "" }] },
  ]);

  const out = await capture(() =>
    fix({
      project,
      home,
      env: {},
      fixer,
      yes: true,
      buildCmd: "test -f build.ok",
      testCmd: "test -f test.ok",
    }),
  );

  expect(out).toContain("Done — build and tests are green");
});
