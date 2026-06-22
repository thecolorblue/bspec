import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../../src/commands/build.ts";
import { blockPath } from "../../src/config.ts";
import type { BlockAuthorOutput } from "../../src/lib/schemas.ts";
import { FakeBlockAuthor } from "../helpers/fake-block-author.ts";

const GREETING_FIXTURE = join(import.meta.dir, "../fixtures/greeting-page.block.ts");
const CONTACT_FIXTURE = join(import.meta.dir, "../fixtures/contact-page.block.ts");

const SPEC = `# Overview\nA landing site.\n\n# Features\n- A greeting page.\n- A contact page.\n`;

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

/** A plan with one buildable step (greeting) and one unfilled gap (contact). */
async function writePlanWithGap(): Promise<void> {
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(
    join(project, ".bspec", "plan.json"),
    JSON.stringify({
      spec_hash: "abc",
      steps: [
        {
          id: "greeting-page",
          version: "1.0.0",
          summary: "Building the greeting page",
          params: { title: "Tab Saver" },
          needs: [],
        },
      ],
      gaps: [{ feature: "a contact page", reason: "no block provides a contact form" }],
      planner: { agent: "anthropic/claude-opus-4-5", pi_version: "0.76.0", planned_at: "t" },
    }),
  );
}

async function contactOutput(): Promise<BlockAuthorOutput> {
  return {
    block: { source: await readFile(CONTACT_FIXTURE, "utf8") },
    step: {
      id: "contact-page",
      version: "1.0.0",
      summary: "Adding a contact page",
      params: { heading: "Contact Us" },
      needs: [],
    },
  };
}

async function readPlan(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(project, ".bspec", "plan.json"), "utf8"));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-home-"));
  project = await mkdtemp(join(tmpdir(), "bspec-project-"));
  await writeFile(join(project, "SPEC.md"), SPEC);
  await mkdir(join(home, "blocks"), { recursive: true });
  await cp(GREETING_FIXTURE, blockPath("greeting-page", home));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test("build authors a gap block, installs it, and builds the completed app", async () => {
  await writePlanWithGap();
  const author = new FakeBlockAuthor(await contactOutput());

  const out = await capture(() => build({ project, home, author, yes: true }));

  expect(out).toContain("Authored contact-page@1.0.0");
  expect(out).toContain("(0 replayed, 2 ran)");
  expect(existsSync(join(project, "dist", "index.html"))).toBe(true);
  expect(existsSync(join(project, "dist", "contact.html"))).toBe(true);

  // The authored block was installed into the registry for reuse.
  expect(existsSync(blockPath("contact-page", home))).toBe(true);

  // The authored block was given the SPEC and the already-taken names.
  expect(author.calls[0].spec).toContain("contact page");
  expect(author.calls[0].takenIds).toContain("greeting-page");
  expect(author.calls[0].takenProduces).toContain("index.html");
});

test("greenfield plan with no steps authors every gap from scratch", async () => {
  // A brand-new app: nothing to build on top of, all work is gaps.
  await mkdir(join(project, ".bspec"), { recursive: true });
  await writeFile(
    join(project, ".bspec", "plan.json"),
    JSON.stringify({
      spec_hash: "greenfield",
      steps: [],
      gaps: [{ feature: "a contact page", reason: "no block provides a contact form" }],
      planner: { agent: "anthropic/claude-opus-4-5", pi_version: "0.76.0", planned_at: "t" },
    }),
  );
  const author = new FakeBlockAuthor(await contactOutput());

  const out = await capture(() => build({ project, home, author, yes: true }));

  expect(out).toContain("Authored contact-page@1.0.0");
  expect(out).toContain("(0 replayed, 1 ran)");
  expect(existsSync(join(project, "dist", "contact.html"))).toBe(true);

  // The single authored step is folded into the plan; no gaps remain.
  const written = await readPlan();
  expect((written.steps as Array<{ id: string }>).map((s) => s.id)).toEqual(["contact-page"]);
  expect(written.gaps).toEqual([]);
});

test("authored gaps are folded into plan.json so a rebuild replays deterministically", async () => {
  await writePlanWithGap();
  const author = new FakeBlockAuthor(await contactOutput());

  await capture(() => build({ project, home, author, yes: true }));

  const written = await readPlan();
  expect((written.steps as Array<{ id: string }>).map((s) => s.id)).toEqual([
    "greeting-page",
    "contact-page",
  ]);
  expect(written.gaps).toEqual([]);
  // Provenance and spec_hash are preserved across the rewrite.
  expect(written.spec_hash).toBe("abc");
  expect((written.planner as Record<string, string>).agent).toBe("anthropic/claude-opus-4-5");

  // Rebuild: no gaps remain, so the author is never consulted again.
  const rebuildAuthor = new FakeBlockAuthor(await contactOutput());
  const second = await capture(() => build({ project, home, author: rebuildAuthor, yes: true }));
  expect(second).toContain("(2 replayed, 0 ran)");
  expect(rebuildAuthor.calls.length).toBe(0);
});

test("the approval prompt gates authoring: a 'no' answer leaves the gap unbuilt", async () => {
  await writePlanWithGap();
  const author = new FakeBlockAuthor(await contactOutput());

  const out = await capture(() =>
    build({ project, home, author, ask: scriptedAsk(["n"]) }),
  );

  expect(out).toContain("Skipping block authoring");
  expect(author.calls.length).toBe(0);
  expect(existsSync(join(project, "dist", "contact.html"))).toBe(false);
  expect(existsSync(join(project, "dist", "index.html"))).toBe(true);

  // The gap is preserved in plan.json (resumable).
  const written = await readPlan();
  expect((written.gaps as unknown[]).length).toBe(1);
});

test("--no-author builds only the planned steps and reports the remaining gap", async () => {
  await writePlanWithGap();
  const author = new FakeBlockAuthor(await contactOutput());

  const out = await capture(() => build({ project, home, author, noAuthor: true }));

  expect(author.calls.length).toBe(0);
  expect(out).toContain("authoring is off (--no-author)");
  expect(out).toContain("(0 replayed, 1 ran)");
  expect(out).toContain("still");
  expect(existsSync(join(project, "dist", "contact.html"))).toBe(false);
});

test("cached blocks are added to the project and announced before authoring runs", async () => {
  await writePlanWithGap();

  // First pass with --no-author: builds + caches greeting, leaves the gap intact.
  await capture(() => build({ project, home, noAuthor: true }));
  expect(existsSync(join(project, "dist", "index.html"))).toBe(true);

  // Second pass: greeting is cached, so it is replayed into the project and
  // announced up front, then the gap is authored and built.
  const author = new FakeBlockAuthor(await contactOutput());
  const out = await capture(() => build({ project, home, author, yes: true }));

  const addedAt = out.indexOf("Adding 1 cached block to the project");
  const authoringAt = out.indexOf("Authoring + building");
  expect(addedAt).toBeGreaterThanOrEqual(0);
  expect(authoringAt).toBeGreaterThan(addedAt);

  // greeting replayed from cache, contact authored + run → (1 replayed, 1 ran).
  expect(out).toContain("(1 replayed, 1 ran)");
  expect(existsSync(join(project, "dist", "contact.html"))).toBe(true);

  // The replayed step's output is claimed before authoring, so the author sees
  // index.html as already taken even though greeting was not re-run.
  expect(author.calls[0].takenProduces).toContain("index.html");
});

test("a failed authoring attempt keeps the gap and still builds the planned steps", async () => {
  await writePlanWithGap();
  // Author returns a block whose manifest id won't match the step id → rejected.
  const badOutput: BlockAuthorOutput = {
    block: { source: await readFile(CONTACT_FIXTURE, "utf8") },
    step: { id: "mismatched-id", version: "1.0.0", summary: "x", params: {}, needs: [] },
  };
  const author = new FakeBlockAuthor(badOutput);

  const out = await capture(() => build({ project, home, author, yes: true }));

  expect(out).toContain('Could not author "a contact page"');
  expect(out).toContain("(0 replayed, 1 ran)");
  expect(existsSync(blockPath("mismatched-id", home))).toBe(false);

  // Gap preserved; plan.json not rewritten (still 1 step, 1 gap).
  const written = await readPlan();
  expect((written.steps as unknown[]).length).toBe(1);
  expect((written.gaps as unknown[]).length).toBe(1);
});
