import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walk } from "../../src/lib/walk.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bspec-walk-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("file walker returns sorted relative paths", async () => {
  await writeFile(join(dir, "b.txt"), "b");
  await writeFile(join(dir, "a.txt"), "a");
  await mkdir(join(dir, "sub"), { recursive: true });
  await writeFile(join(dir, "sub", "c.txt"), "c");

  const result = await walk(dir);
  expect(result).toEqual(["a.txt", "b.txt", "sub/c.txt"]);
});

test("file walker ignores junk directories and files", async () => {
  await writeFile(join(dir, "keep.txt"), "keep");
  await writeFile(join(dir, ".DS_Store"), "junk");
  for (const junk of [".git", "node_modules", "dist", ".bspec"]) {
    await mkdir(join(dir, junk), { recursive: true });
    await writeFile(join(dir, junk, "x.txt"), "x");
  }

  const result = await walk(dir);
  expect(result).toEqual(["keep.txt"]);
});
