import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockPath, blocksDir } from "../../src/config.ts";
import { buildBlockMenu } from "../../src/lib/menu.ts";
import { checkRegistry } from "../../src/lib/plan-validate.ts";
import { PiPlanner } from "../../src/lib/planner-pi.ts";

/**
 * The single live test: exercises the real PiPlanner against a real provider.
 * Skipped unless BSPEC_LIVE=1 (and Pi is authenticated). It asserts only that a
 * parseable, registry-valid plan comes back — never exact wording.
 */
const LIVE = process.env.BSPEC_LIVE === "1";

const GREETING_FIXTURE = join(import.meta.dir, "../fixtures/greeting-page.block.ts");
const SPEC_FIXTURE = join(import.meta.dir, "../fixtures/spec/SPEC.md");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bspec-live-home-"));
  await mkdir(blocksDir(home), { recursive: true });
  await cp(GREETING_FIXTURE, blockPath("greeting-page", home), { force: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test.skipIf(!LIVE)(
  "PiPlanner returns a registry-valid plan for the sample spec",
  async () => {
    const spec = await readFile(SPEC_FIXTURE, "utf8");
    const menu = await buildBlockMenu(home);

    const planner = new PiPlanner({ selector: process.env.BSPEC_AGENT });
    const output = await planner.plan({ spec, menu });

    // The pipeline already guaranteed this inside plan(); re-assert it here.
    expect(checkRegistry(output, menu)).toBeNull();
    expect(Array.isArray(output.steps)).toBe(true);

    const prov = planner.provenance();
    expect(typeof prov?.pi_version).toBe("string");
  },
  120_000,
);
