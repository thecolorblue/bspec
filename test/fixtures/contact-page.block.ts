#!/usr/bin/env bun
// Hand-written parameterized block fixture: a contact page. Used as the block a
// FakeBlockAuthor "authors" to fill a gap, and to exercise validateAuthoredBlock.
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const MANIFEST = {
  id: "contact-page",
  version: "1.0.0",
  summary: "A single HTML contact page with a customizable heading and form action.",
  params: {
    heading: { type: "string", required: true, description: "Page heading." },
    action: {
      type: "string",
      required: false,
      default: "#",
      description: "Form submit URL.",
    },
  },
  produces: ["contact.html"],
  needs: [] as string[],
} as const;

interface Params {
  heading: string;
  action?: string;
}

function render(p: Params): string {
  const action = p.action ?? "#";
  return `<!doctype html>
<html>
  <head><title>${p.heading}</title></head>
  <body>
    <h1>${p.heading}</h1>
    <form method="post" action="${action}">
      <input type="email" name="email" placeholder="Your email" required />
      <textarea name="message" placeholder="Your message"></textarea>
      <button type="submit">Send</button>
    </form>
  </body>
</html>
`;
}

async function readParams(file?: string): Promise<Params> {
  if (!file) return { heading: "Contact Us" };
  return JSON.parse(await readFile(file, "utf8")) as Params;
}

async function applyTo(outDir: string, params: Params): Promise<void> {
  const dest = join(outDir, "contact.html");
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, render(params));
}

async function selfTest(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "contact-page-test-"));
  try {
    await applyTo(dir, { heading: "Reach Us", action: "/send" });
    const html = await readFile(join(dir, "contact.html"), "utf8");
    if (!html.includes("Reach Us")) throw new Error("heading not rendered");
    if (!html.includes("/send")) throw new Error("action not rendered");
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
