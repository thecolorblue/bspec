import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_ITERS,
  DEFAULT_PROTECTED,
  DEFAULT_TOKEN_BUDGET,
  fixConfigPath,
  loadFixConfig,
  parseSpecVerification,
} from "../../src/lib/fix/config.ts";

let project: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "bspec-fix-cfg-"));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

async function writeFixJson(obj: unknown): Promise<void> {
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(fixConfigPath(project), JSON.stringify(obj));
}

test("loads commands and applies defaults for omitted fields", async () => {
  await writeFixJson({ build: { cmd: "make build" }, test: { cmd: "make test" } });
  const cfg = await loadFixConfig(project);
  expect(cfg.build.cmd).toBe("make build");
  expect(cfg.test.cmd).toBe("make test");
  expect(cfg.maxIters).toBe(DEFAULT_MAX_ITERS);
  expect(cfg.tokenBudget).toBe(DEFAULT_TOKEN_BUDGET);
  expect(cfg.protected).toEqual([...DEFAULT_PROTECTED]);
  expect(cfg.allowShell).toBe(false);
});

test("throws a clear error when the build command is absent everywhere", async () => {
  await writeFixJson({ test: { cmd: "make test" } });
  await expect(loadFixConfig(project)).rejects.toThrow(/No build command/);
});

test("throws when the test command is absent everywhere", async () => {
  await writeFixJson({ build: { cmd: "make build" } });
  await expect(loadFixConfig(project)).rejects.toThrow(/No test command/);
});

test("CLI overrides beat fix.json", async () => {
  await writeFixJson({
    build: { cmd: "make build" },
    test: { cmd: "make test" },
    maxIters: 5,
  });
  const cfg = await loadFixConfig(project, { buildCmd: "npm run build", maxIters: 3 });
  expect(cfg.build.cmd).toBe("npm run build");
  expect(cfg.test.cmd).toBe("make test");
  expect(cfg.maxIters).toBe(3);
});

test("fix.json beats SPEC.md, and SPEC.md fills the gap fix.json leaves", async () => {
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(
    join(project, "SPEC.md"),
    "# App\n\n## Verification\n- build: `spec build`\n- test: `spec test`\n",
  );
  await writeFile(fixConfigPath(project), JSON.stringify({ build: { cmd: "file build" } }));
  const cfg = await loadFixConfig(project);
  expect(cfg.build.cmd).toBe("file build"); // file wins over SPEC.md
  expect(cfg.test.cmd).toBe("spec test"); // SPEC.md fills the missing test cmd
});

test("throws on invalid JSON", async () => {
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(fixConfigPath(project), "{not json");
  await expect(loadFixConfig(project)).rejects.toThrow(/not valid JSON/);
});

test("throws on a wrong-shaped config", async () => {
  await writeFixJson({ build: { cmd: "x" }, test: { cmd: "y" }, maxIters: -1 });
  await expect(loadFixConfig(project)).rejects.toThrow(/Invalid fix config/);
});

test("parseSpecVerification extracts commands only from the Verification section", () => {
  const spec = [
    "# Title",
    "Some prose.",
    "## Verification",
    "- build: `npm run build`",
    "- test: `npm test`",
    "## Next",
    "- build: `should not match here`",
  ].join("\n");
  expect(parseSpecVerification(spec)).toEqual({
    buildCmd: "npm run build",
    testCmd: "npm test",
  });
});

test("parseSpecVerification returns empty without a Verification section", () => {
  expect(parseSpecVerification("# Title\nno verification here")).toEqual({});
});
