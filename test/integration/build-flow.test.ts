import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocksAdd } from "../../src/commands/blocks-add.ts";
import { blocksTest } from "../../src/commands/blocks-test.ts";
import { build } from "../../src/commands/build.ts";
import { cacheLs } from "../../src/commands/cache-ls.ts";
import { cacheVerify } from "../../src/commands/cache-verify.ts";
import { blockPath, cacheDir } from "../../src/config.ts";
import { runBlock } from "../../src/lib/blocks.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/hello-extension-source");

let home: string;
let project: string;

/** Capture everything written to process.stdout while fn runs. */
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

async function writePlan(): Promise<void> {
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(
    join(project, ".bspec", "plan.json"),
    JSON.stringify({
      spec_hash: "manual-v0",
      steps: [
        {
          id: "hello-extension",
          version: "0.1.0",
          summary: "Building hello extension",
          params: {},
          needs: [],
        },
      ],
    }),
  );
}

async function addBlock(): Promise<void> {
  await capture(() =>
    blocksAdd({
      folder: FIXTURE,
      id: "hello-extension",
      version: "0.1.0",
      summary: "A minimal hello extension fixture",
      home,
    }),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-home-"));
  project = await mkdtemp(join(tmpdir(), "bspec-project-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test("blocks add creates a single executable block file in BSPEC_HOME", async () => {
  await addBlock();
  expect(existsSync(blockPath("hello-extension", home))).toBe(true);
});

test("blocks add captures a single file when --file is provided", async () => {
  const sourceFile = join(project, "single.txt");
  await writeFile(sourceFile, "Hello from a single file block.");

  await capture(() =>
    blocksAdd({
      file: sourceFile,
      id: "single-file",
      version: "1.0.0",
      summary: "Just one file",
      home,
    }),
  );

  const block = blockPath("single-file", home);
  expect(existsSync(block)).toBe(true);
  const result = await runBlock(block, ["--manifest"]);
  expect(result.code).toBe(0);
  const manifest = JSON.parse(result.stdout);
  expect(manifest.produces).toEqual(["single.txt"]);
  expect(manifest.summary).toBe("Just one file");
});

test("running the generated block with --manifest prints valid JSON", async () => {
  await addBlock();
  const result = await runBlock(blockPath("hello-extension", home), ["--manifest"]);
  expect(result.code).toBe(0);
  const manifest = JSON.parse(result.stdout);
  expect(manifest.id).toBe("hello-extension");
  expect(manifest.version).toBe("0.1.0");
  expect(manifest.produces).toEqual(["manifest.json", "popup.html", "popup.js"]);
  expect(manifest.needs).toEqual([]);
});

test("blocks test passes for the generated block", async () => {
  await addBlock();
  const out = await capture(() => blocksTest("hello-extension", { home }));
  expect(out).toContain("Testing hello-extension@0.1.0... ok");
});

test("a handwritten plan builds the fixture into the app's dist/", async () => {
  await addBlock();
  await writePlan();
  await capture(() => build({ project, home }));

  for (const f of ["manifest.json", "popup.html", "popup.js"]) {
    const built = await readFile(join(project, "dist", f));
    const source = await readFile(join(FIXTURE, f));
    expect(built.equals(source)).toBe(true);
  }
});

test("first build prints [ran] and creates a cache entry", async () => {
  await addBlock();
  await writePlan();
  const out = await capture(() => build({ project, home }));
  expect(out).toContain("[ran]");
  expect(out).toContain("(0 replayed, 1 ran)");
  const keys = await import("node:fs/promises").then((m) => m.readdir(cacheDir(home)));
  expect(keys.length).toBe(1);
});

test("second build prints [replayed] with the same cache key", async () => {
  await addBlock();
  await writePlan();
  const first = await capture(() => build({ project, home }));
  const second = await capture(() => build({ project, home }));

  const keyOf = (s: string) => s.match(/-> ([0-9a-f]{64})/)?.[1];
  expect(first).toContain("[ran]");
  expect(second).toContain("[replayed]");
  expect(keyOf(first)).toBe(keyOf(second));
});

test("deleting dist and rebuilding restores from cache as [replayed]", async () => {
  await addBlock();
  await writePlan();
  await capture(() => build({ project, home }));
  await rm(join(project, "dist"), { recursive: true, force: true });
  const out = await capture(() => build({ project, home }));
  expect(out).toContain("[replayed]");
  expect(existsSync(join(project, "dist", "popup.js"))).toBe(true);
});

test("build.json maps every output to the block and cache key", async () => {
  await addBlock();
  await writePlan();
  const out = await capture(() => build({ project, home }));
  const key = out.match(/-> ([0-9a-f]{64})/)?.[1];

  const provenance = JSON.parse(
    await readFile(join(project, ".bspec", "build.json"), "utf8"),
  );
  for (const f of ["manifest.json", "popup.html", "popup.js"]) {
    expect(provenance.outputs[f].by).toBe("hello-extension@0.1.0");
    expect(provenance.outputs[f].cache).toBe(key);
    expect(provenance.outputs[f].hash).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("cache ls shows the saved cache entry", async () => {
  await addBlock();
  await writePlan();
  await capture(() => build({ project, home }));
  const out = await capture(() => cacheLs({ home }));
  expect(out).toContain("hello-extension");
  expect(out).toContain("fresh");
});

test("cache verify passes after a successful build", async () => {
  await addBlock();
  await writePlan();
  await capture(() => build({ project, home }));
  const out = await capture(() => cacheVerify({ home }));
  expect(out).toContain("All ok");
});

test("build rejects a step with non-empty needs", async () => {
  await addBlock();
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(
    join(project, ".bspec", "plan.json"),
    JSON.stringify({
      steps: [{ id: "hello-extension", version: "0.1.0", params: {}, needs: ["other"] }],
    }),
  );
  await expect(build({ project, home })).rejects.toThrow(
    /Dependency graph builds are not supported in v0/,
  );
});

test("build fails with a clear message when no plan exists", async () => {
  await expect(build({ project, home })).rejects.toThrow(/No plan found/);
});
