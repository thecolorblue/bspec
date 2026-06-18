#!/usr/bin/env bun
// Hand-written parameterized block fixture for bspec v1 (tests + demo).
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const MANIFEST = {
  id: "greeting-page",
  version: "1.0.0",
  summary: "A single HTML greeting page with a customizable title and message.",
  params: {
    title: { type: "string", required: true, description: "Page heading." },
    message: {
      type: "string",
      required: false,
      default: "Welcome!",
      description: "Body text.",
    },
  },
  produces: ["index.html"],
  needs: [] as string[],
} as const;

interface Params {
  title: string;
  message?: string;
}

function render(p: Params): string {
  const message = p.message ?? "Welcome!";
  return `<!doctype html>
<html>
  <head><title>${p.title}</title></head>
  <body>
    <h1>${p.title}</h1>
    <p>${message}</p>
  </body>
</html>
`;
}

async function readParams(file?: string): Promise<Params> {
  if (!file) return { title: "Hello" };
  return JSON.parse(await readFile(file, "utf8")) as Params;
}

async function applyTo(outDir: string, params: Params): Promise<void> {
  const dest = join(outDir, "index.html");
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, render(params));
}

async function selfTest(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "greeting-page-test-"));
  try {
    await applyTo(dir, { title: "Test Title", message: "Hi" });
    const html = await readFile(join(dir, "index.html"), "utf8");
    if (!html.includes("Test Title")) throw new Error("title not rendered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [flag, ...rest] = process.argv.slice(2);
  if (flag === "--manifest") {
    process.stdout.write(JSON.stringify(MANIFEST, null, 2) + "\n");
    return;
  }
  if (flag === "--apply") {
    const outDir = rest[0];
    if (!outDir) {
      process.stderr.write("Usage: <block> --apply <out_dir> <params.json>\n");
      process.exit(2);
    }
    await applyTo(outDir, await readParams(rest[1]));
    return;
  }
  if (flag === "--test") {
    try {
      await selfTest();
      process.stdout.write("ok\n");
    } catch (err) {
      process.stderr.write("FAIL: " + (err as Error).message + "\n");
      process.exit(1);
    }
    return;
  }
  process.stderr.write("Unknown command. Use --manifest, --apply, or --test.\n");
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(String((err as Error)?.stack ?? err) + "\n");
  process.exit(1);
});
