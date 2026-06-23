import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTree, SnapshotCheckpointer } from "../../src/lib/fix/checkpoint.ts";

const IGNORE = [".git", "node_modules", ".bspec"];

async function setup(): Promise<{ project: string; cp: SnapshotCheckpointer }> {
  const project = await mkdtemp(join(tmpdir(), "bspec-ckpt-"));
  const cp = new SnapshotCheckpointer(project, join(project, ".bspec", "fix", "snapshots"), IGNORE);
  return { project, cp };
}

test("restore reverts modifications, additions, and deletions", async () => {
  const { project, cp } = await setup();
  try {
    await writeFile(join(project, "a.txt"), "original");
    await writeFile(join(project, "keep.txt"), "keep");
    const ref = await cp.snapshot("baseline");

    await writeFile(join(project, "a.txt"), "MODIFIED");
    await writeFile(join(project, "b.txt"), "new file");
    await rm(join(project, "keep.txt"));

    await cp.restore(ref);

    expect(await readFile(join(project, "a.txt"), "utf8")).toBe("original");
    expect(existsSync(join(project, "b.txt"))).toBe(false); // added file removed
    expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("keep"); // deletion undone
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("snapshots ignore configured directories", async () => {
  const { project, cp } = await setup();
  try {
    await mkdir(join(project, "node_modules"), { recursive: true });
    await writeFile(join(project, "node_modules", "dep.js"), "x");
    await writeFile(join(project, "src.ts"), "code");
    const ref = await cp.snapshot("baseline");

    const manifest = await cp.manifestFor(ref);
    expect(Object.keys(manifest)).toContain("src.ts");
    expect(Object.keys(manifest).some((p) => p.startsWith("node_modules"))).toBe(false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("hashTree changes when a file's content changes", async () => {
  const { project } = await setup();
  try {
    await writeFile(join(project, "f.txt"), "one");
    const h1 = await hashTree(project, IGNORE);
    await writeFile(join(project, "f.txt"), "two");
    const h2 = await hashTree(project, IGNORE);
    expect(h1["f.txt"]).not.toBe(h2["f.txt"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
