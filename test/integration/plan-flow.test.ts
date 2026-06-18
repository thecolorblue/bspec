import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blocksAdd } from "../../src/commands/blocks-add.ts";
import { build } from "../../src/commands/build.ts";
import { plan } from "../../src/commands/plan.ts";
import { preview } from "../../src/commands/preview.ts";
import { blockPath } from "../../src/config.ts";
import { sha256Hex } from "../../src/lib/hash.ts";
import type { PlannerOutput } from "../../src/lib/schemas.ts";
import { FakePlanner } from "../helpers/fake-planner.ts";

const HELLO_FIXTURE = join(import.meta.dir, "../fixtures/hello-extension-source");
const GREETING_FIXTURE = join(import.meta.dir, "../fixtures/greeting-page.block.ts");

const SPEC = `# Overview\nA tiny landing page.\n\n# Features\n- A greeting page with the heading "Tab Saver".\n`;

const PROVENANCE = { agent: "anthropic/claude-opus-4-5", pi_version: "0.76.0" };

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

/** A scripted line reader: returns queued answers in order for each prompt. */
function scriptedAsk(responses: string[]): (prompt: string) => Promise<string> {
  let i = 0;
  return () => Promise.resolve(responses[i++] ?? "");
}

function greetingPlan(title: string, message?: string): PlannerOutput {
  const params: Record<string, string> = { title };
  if (message !== undefined) params.message = message;
  return {
    steps: [
      { id: "greeting-page", version: "1.0.0", summary: "Building your greeting page", params, needs: [] },
    ],
    gaps: [],
    questions: [],
  };
}

async function installBlocks(): Promise<void> {
  await capture(() =>
    blocksAdd(HELLO_FIXTURE, {
      id: "hello-extension",
      version: "0.1.0",
      summary: "A minimal hello extension fixture",
      home,
    }),
  );
  await cp(GREETING_FIXTURE, blockPath("greeting-page", home));
}

async function readPlan(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(project, ".bspec", "plan.json"), "utf8"));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-home-"));
  project = await mkdtemp(join(tmpdir(), "bspec-project-"));
  await writeFile(join(project, "SPEC.md"), SPEC);
  await installBlocks();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

test("plan with a fake planner writes plan.json with spec_hash, steps, and provenance", async () => {
  const planner = new FakePlanner(greetingPlan("Tab Saver"), PROVENANCE);
  await capture(() => plan({ project, home, planner, yes: true }));

  const written = await readPlan();
  expect(written.spec_hash).toBe(sha256Hex(SPEC));
  expect((written.steps as Array<{ id: string }>)[0].id).toBe("greeting-page");
  const prov = written.planner as Record<string, string>;
  expect(prov.agent).toBe("anthropic/claude-opus-4-5");
  expect(prov.pi_version).toBe("0.76.0");
  expect(typeof prov.planned_at).toBe("string");
});

test("the planned plan.json then builds with the unchanged build command", async () => {
  const planner = new FakePlanner(greetingPlan("Tab Saver", "Hello there"), PROVENANCE);
  await capture(() => plan({ project, home, planner, yes: true }));
  const out = await capture(() => build({ project, home }));

  expect(out).toContain("[ran]");
  expect(existsSync(join(project, "dist", "index.html"))).toBe(true);
});

test("param-filling end to end: build output reflects the filled title and message", async () => {
  const planner = new FakePlanner(greetingPlan("Tab Saver", "Save every tab"), PROVENANCE);
  await capture(() => plan({ project, home, planner, yes: true }));
  await capture(() => build({ project, home }));

  const html = await readFile(join(project, "dist", "index.html"), "utf8");
  expect(html).toContain("Tab Saver");
  expect(html).toContain("Save every tab");
});

test("clarifying-question loop: a question on round 1, a clean plan on round 2", async () => {
  const question: PlannerOutput = {
    steps: [],
    gaps: [],
    questions: [{ id: "q1", question: "What should the welcome message say?", why: "ambiguous" }],
  };
  const planner = new FakePlanner([question, greetingPlan("Tab Saver", "Welcome!")], PROVENANCE);

  const out = await capture(() =>
    plan({ project, home, planner, ask: scriptedAsk(["Welcome!", "y"]) }),
  );

  expect(out).toContain("What should the welcome message say?");
  const written = await readPlan();
  expect((written.steps as unknown[]).length).toBe(1);
  expect(written.questions).toBeUndefined();
  // The answer was folded into the second planner call.
  expect(planner.calls[1].answers?.[0]?.answer).toBe("Welcome!");
});

test("gaps are surfaced in the review and recorded in plan.json", async () => {
  const withGap: PlannerOutput = {
    ...greetingPlan("Tab Saver"),
    gaps: [{ feature: "a login screen", reason: "no block provides authentication" }],
  };
  const planner = new FakePlanner(withGap, PROVENANCE);

  const out = await capture(() => plan({ project, home, planner, yes: true }));
  expect(out).toContain("Not covered by any block");
  expect(out).toContain("a login screen");

  const written = await readPlan();
  expect((written.gaps as Array<{ feature: string }>)[0].feature).toBe("a login screen");
});

test("semantic-failure path: a hallucinated block throws, writes no plan, leaves plan.log", async () => {
  const hallucinated: PlannerOutput = {
    steps: [
      { id: "auth-block", version: "2.0.0", summary: "Adding auth", params: {}, needs: [] },
    ],
    gaps: [],
    questions: [],
  };
  const planner = new FakePlanner(hallucinated, PROVENANCE);

  await expect(capture(() => plan({ project, home, planner, yes: true }))).rejects.toThrow(
    /isn't installed/,
  );

  expect(existsSync(join(project, ".bspec", "plan.json"))).toBe(false);
  const logPath = join(project, ".bspec", "logs", "plan.log");
  expect(existsSync(logPath)).toBe(true);
  expect(await readFile(logPath, "utf8")).toContain("auth-block");
});

test("approval gate: a 'no' answer exits without writing plan.json", async () => {
  const planner = new FakePlanner(greetingPlan("Tab Saver"), PROVENANCE);
  const out = await capture(() => plan({ project, home, planner, ask: scriptedAsk(["n"]) }));

  expect(out).toContain("Plan not written.");
  expect(existsSync(join(project, ".bspec", "plan.json"))).toBe(false);
});

test("non-interactive: --answers resolves questions and --yes writes without prompting", async () => {
  const question: PlannerOutput = {
    steps: [],
    gaps: [],
    questions: [{ id: "q1", question: "Welcome text?", why: "ambiguous" }],
  };
  const planner = new FakePlanner([question, greetingPlan("Tab Saver", "Welcome!")], PROVENANCE);

  const answersFile = join(project, "answers.json");
  await writeFile(answersFile, JSON.stringify([{ id: "q1", answer: "Welcome!" }]));

  await capture(() => plan({ project, home, planner, yes: true, answers: answersFile }));

  const written = await readPlan();
  expect((written.steps as unknown[]).length).toBe(1);
  expect(written.questions).toBeUndefined();
  expect(planner.calls.length).toBe(2);
});

test("non-interactive without answers fails clearly when the planner asks (--yes)", async () => {
  const question: PlannerOutput = {
    steps: [],
    gaps: [],
    questions: [{ id: "q1", question: "Welcome text?" }],
  };
  const planner = new FakePlanner(question, PROVENANCE);

  await expect(capture(() => plan({ project, home, planner, yes: true }))).rejects.toThrow(
    /needs answers but none were provided/,
  );
  expect(existsSync(join(project, ".bspec", "plan.json"))).toBe(false);
});

test("missing SPEC.md fails with a clear, actionable message", async () => {
  await rm(join(project, "SPEC.md"));
  const planner = new FakePlanner(greetingPlan("Tab Saver"), PROVENANCE);
  await expect(capture(() => plan({ project, home, planner, yes: true }))).rejects.toThrow(
    /No SPEC.md found/,
  );
});

test("empty registry fails before any planning", async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), "bspec-empty-"));
  try {
    const planner = new FakePlanner(greetingPlan("Tab Saver"), PROVENANCE);
    await expect(
      capture(() => plan({ project, home: emptyHome, planner, yes: true })),
    ).rejects.toThrow(/No blocks installed/);
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
  }
});

test("end to end: plan → build [ran] → build [replayed] → preview lists files", async () => {
  const planner = new FakePlanner(greetingPlan("Tab Saver", "Welcome!"), PROVENANCE);
  await capture(() => plan({ project, home, planner, yes: true }));

  const first = await capture(() => build({ project, home }));
  const second = await capture(() => build({ project, home }));
  const keyOf = (s: string) => s.match(/-> ([0-9a-f]{64})/)?.[1];

  expect(first).toContain("[ran]");
  expect(second).toContain("[replayed]");
  expect(keyOf(first)).toBe(keyOf(second));

  const out = await capture(() => preview({ project }));
  expect(out).toContain("index.html");
});

test("a planned plan.json with gaps/planner builds identically to a v0 plan", async () => {
  const planner = new FakePlanner(
    { ...greetingPlan("Tab Saver"), gaps: [{ feature: "login", reason: "no auth block" }] },
    PROVENANCE,
  );
  await capture(() => plan({ project, home, planner, yes: true }));

  // gaps + planner provenance are present, yet build ignores them.
  const written = await readPlan();
  expect(written.gaps).toBeDefined();
  expect(written.planner).toBeDefined();

  const out = await capture(() => build({ project, home }));
  expect(out).toContain("(0 replayed, 1 ran)");
});
