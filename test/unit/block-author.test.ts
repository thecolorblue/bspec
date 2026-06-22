import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockPath } from "../../src/config.ts";
import {
  installAuthoredBlock,
  parseAuthorOutput,
  validateAuthoredBlock,
  type BlockAuthorInput,
} from "../../src/lib/block-author.ts";
import type { BlockAuthorOutput } from "../../src/lib/schemas.ts";

const CONTACT_FIXTURE = join(import.meta.dir, "../fixtures/contact-page.block.ts");

async function contactSource(): Promise<string> {
  return readFile(CONTACT_FIXTURE, "utf8");
}

function baseInput(over: Partial<BlockAuthorInput> = {}): BlockAuthorInput {
  return {
    gap: { feature: "a contact page", reason: "no block provides one" },
    spec: "# Overview\nA site with a contact page.\n",
    takenIds: ["greeting-page"],
    takenProduces: ["index.html"],
    ...over,
  };
}

async function contactOutput(over: Partial<BlockAuthorOutput["step"]> = {}): Promise<BlockAuthorOutput> {
  return {
    block: { source: await contactSource() },
    step: {
      id: "contact-page",
      version: "1.0.0",
      summary: "Adding a contact page",
      params: { heading: "Contact Us" },
      needs: [],
      ...over,
    },
  };
}

test("validateAuthoredBlock accepts a contract-honoring block that self-tests", async () => {
  const result = await validateAuthoredBlock(await contactOutput(), baseInput());
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.step.id).toBe("contact-page");
    expect(result.produces).toEqual(["contact.html"]);
  }
});

test("validateAuthoredBlock rejects an id that is already taken", async () => {
  const result = await validateAuthoredBlock(
    await contactOutput(),
    baseInput({ takenIds: ["greeting-page", "contact-page"] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toMatch(/already in use/);
});

test("validateAuthoredBlock rejects a produces collision with another step", async () => {
  const result = await validateAuthoredBlock(
    await contactOutput(),
    baseInput({ takenProduces: ["index.html", "contact.html"] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toMatch(/overwrite "contact\.html"/);
});

test("validateAuthoredBlock rejects when the manifest id differs from the step id", async () => {
  const result = await validateAuthoredBlock(
    await contactOutput({ id: "wrong-id" }),
    baseInput(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toMatch(/must match the step id/);
});

test("validateAuthoredBlock rejects an unknown param on the step", async () => {
  const result = await validateAuthoredBlock(
    await contactOutput({ params: { heading: "Hi", nope: "x" } }),
    baseInput(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toMatch(/doesn't accept it/);
});

test("validateAuthoredBlock rejects a missing required param", async () => {
  const result = await validateAuthoredBlock(await contactOutput({ params: {} }), baseInput());
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toMatch(/requires "heading"/);
});

test("validateAuthoredBlock rejects a block whose self-test fails", async () => {
  const brokenSource = `#!/usr/bin/env bun
const MANIFEST = { id: "broken", version: "1.0.0", summary: "s", params: {}, produces: ["x.txt"], needs: [] };
const [flag] = process.argv.slice(2);
if (flag === "--manifest") process.stdout.write(JSON.stringify(MANIFEST));
else if (flag === "--test") { process.stderr.write("FAIL: boom\\n"); process.exit(1); }
`;
  const result = await validateAuthoredBlock(
    { block: { source: brokenSource }, step: { id: "broken", version: "1.0.0", summary: "s", params: {}, needs: [] } },
    baseInput({ takenIds: [] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toMatch(/self-test \(--test\) failed/);
});

test("parseAuthorOutput reads a plain JSON object", () => {
  const raw = JSON.stringify({
    block: { source: "x" },
    step: { id: "c", version: "1.0.0", summary: "s", params: {} },
  });
  const result = parseAuthorOutput(raw);
  expect(result.ok).toBe(true);
});

test("parseAuthorOutput strips a code fence", () => {
  const raw =
    "```json\n" +
    JSON.stringify({ block: { source: "x" }, step: { id: "c", version: "1.0.0", summary: "s", params: {} } }) +
    "\n```";
  expect(parseAuthorOutput(raw).ok).toBe(true);
});

test("parseAuthorOutput rejects non-JSON and malformed shapes", () => {
  expect(parseAuthorOutput("not json at all").ok).toBe(false);
  expect(parseAuthorOutput(JSON.stringify({ block: {} })).ok).toBe(false);
});

test("installAuthoredBlock writes an executable block into the registry", async () => {
  const home = await mkdtemp(join(tmpdir(), "bspec-home-"));
  try {
    const dest = await installAuthoredBlock(await contactSource(), "contact-page", home);
    expect(dest).toBe(blockPath("contact-page", home));
    expect(existsSync(dest)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
