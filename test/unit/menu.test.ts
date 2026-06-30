import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocksAdd } from "../../src/commands/blocks-add.ts";
import { blockPath, blocksDir } from "../../src/config.ts";
import { buildBlockMenu } from "../../src/lib/menu.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/hello-extension-source");
const GREETING = join(import.meta.dir, "../fixtures/greeting-page.block.ts");

let home: string;

async function capture(fn: () => Promise<void>): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = () => true;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("buildBlockMenu returns metadata for installed blocks and omits payloads", async () => {
  await capture(() =>
    blocksAdd({
      folder: FIXTURE,
      id: "hello-extension",
      version: "0.1.0",
      summary: "A minimal hello extension fixture",
      home,
    }),
  );
  await cp(GREETING, blockPath("greeting-page", home));

  const menu = await buildBlockMenu(home);
  const ids = menu.map((e) => e.id).sort();
  expect(ids).toEqual(["greeting-page", "hello-extension"]);

  const greeting = menu.find((e) => e.id === "greeting-page");
  expect(greeting?.version).toBe("1.0.0");
  expect(greeting?.params.title.required).toBe(true);
  expect(greeting?.produces).toEqual(["index.html"]);

  // The menu carries only metadata — no embedded file contents.
  const json = JSON.stringify(menu);
  expect(json).not.toContain("<!doctype html>");
  expect(json).not.toContain("manifest_version");
  for (const entry of menu) {
    expect(Object.keys(entry).sort()).toEqual([
      "id",
      "params",
      "produces",
      "summary",
      "version",
    ]);
  }
});

test("buildBlockMenu returns an empty array when no blocks are installed", async () => {
  expect(await buildBlockMenu(home)).toEqual([]);
  expect(blocksDir(home)).toContain("blocks");
});
