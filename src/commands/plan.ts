import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { resolveBspecHome } from "../config.ts";
import { agentSourceLabel, resolveAgentSelector } from "../lib/agent.ts";
import { blocksDir } from "../config.ts";
import { BspecError } from "../lib/errors.ts";
import { sha256Hex } from "../lib/hash.ts";
import { buildBlockMenu } from "../lib/menu.ts";
import { checkRegistry } from "../lib/plan-validate.ts";
import { PiPlanner } from "../lib/planner-pi.ts";
import {
  PlannerError,
  type ClarifyingAnswer,
  type Planner,
  type PlannerInput,
} from "../lib/planner.ts";
import type { PlannerOutput } from "../lib/schemas.ts";

/** Cap on clarifying-question rounds so a confused model can't loop forever. */
const MAX_ROUNDS = 3;

const answersFileSchema = z.array(
  z.object({ id: z.string().min(1), answer: z.string() }),
);

export interface PlanOptions {
  project?: string;
  home?: string;
  /** `--agent` selector override for this run. */
  agent?: string;
  /** Non-interactive: skip the approval prompt and write the plan. */
  yes?: boolean;
  /** Path to a JSON array of `{ id, answer }` answering clarifying questions. */
  answers?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable planner (defaults to `PiPlanner`). */
  planner?: Planner;
  /** Injectable line reader for prompts/approval (defaults to stdin readline). */
  ask?: (prompt: string) => Promise<string>;
}

export async function plan(opts: PlanOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveBspecHome(env);
  const project = resolve(opts.project ?? process.cwd());

  const specFile = join(project, "SPEC.md");
  if (!existsSync(specFile)) {
    throw new BspecError(
      `No SPEC.md found at ${specFile}. Write one (see the template) before running bspec plan.`,
    );
  }
  const specText = await readFile(specFile, "utf8");
  const specHash = sha256Hex(specText);

  const menu = await buildBlockMenu(home);
  if (menu.length === 0) {
    throw new BspecError(
      `No blocks installed in ${blocksDir(home)}. Add blocks before planning.`,
    );
  }

  const resolved = await resolveAgentSelector({ flag: opts.agent, env, home });
  const header = resolved.selector
    ? `Planning from SPEC.md using ${resolved.selector} (${agentSourceLabel(resolved.source)})…`
    : "Planning from SPEC.md using Pi's default model…";
  process.stdout.write(header + "\n");

  const fileAnswers = await loadAnswers(opts.answers);
  const interactive = !opts.yes && (opts.ask !== undefined || (process.stdin.isTTY ?? false));
  const asker = makeAsker(opts.ask);

  const planner =
    opts.planner ??
    new PiPlanner({ selector: resolved.selector, onInfo: writeInfo, interactive });

  try {
    const output = await runPlanRounds({
      planner,
      project,
      spec: specText,
      menu,
      fileAnswers,
      interactive,
      yes: opts.yes ?? false,
      ask: asker.ask,
    });
    if (!output) return; // questions printed, nothing to write (non-interactive, no --yes)

    // Final trust guard: nothing unvalidated is ever written, whatever planner ran.
    const semanticError = checkRegistry(output, menu);
    if (semanticError) {
      await writePlanLog(project, JSON.stringify(output, null, 2));
      throw new BspecError(semanticError);
    }

    printReview(output);

    const approved = opts.yes || (await confirm(asker.ask, interactive));
    if (!approved) {
      process.stdout.write("Plan not written.\n");
      return;
    }

    await writePlan(project, specHash, output, planner, resolved.selector);
  } catch (err) {
    if (err instanceof PlannerError && err.rawOutput !== undefined) {
      const logPath = await writePlanLog(project, err.rawOutput);
      throw new BspecError(`${err.message} Raw output saved to ${displayPath(logPath)}.`);
    }
    throw err;
  } finally {
    asker.close();
  }
}

interface RoundsContext {
  planner: Planner;
  project: string;
  spec: string;
  menu: PlannerInput["menu"];
  fileAnswers: ClarifyingAnswer[];
  interactive: boolean;
  yes: boolean;
  ask: (prompt: string) => Promise<string>;
}

/**
 * Run plan rounds, folding clarifying answers back in until the planner is
 * confident or a round cap is hit. Returns the confident output, or `undefined`
 * when questions remain and there's no way to answer them (non-interactive,
 * no `--yes`) — the caller then writes nothing.
 */
async function runPlanRounds(ctx: RoundsContext): Promise<PlannerOutput | undefined> {
  const answers: ClarifyingAnswer[] = [...ctx.fileAnswers];
  let usedFileAnswers = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const output = await ctx.planner.plan({ spec: ctx.spec, menu: ctx.menu, answers });
    if (output.questions.length === 0) return output;

    if (ctx.interactive) {
      printQuestions(output);
      for (const q of output.questions) {
        const answer = await ctx.ask("> ");
        answers.push({ id: q.id, answer });
      }
      process.stdout.write("Re-planning with your answers…\n");
      continue;
    }

    // Non-interactive: give the supplied --answers exactly one re-plan chance.
    if (ctx.fileAnswers.length > 0 && !usedFileAnswers) {
      usedFileAnswers = true;
      continue;
    }

    if (ctx.yes) {
      throw new BspecError(
        "The plan needs answers but none were provided. " +
          "Re-run interactively or pass --answers <file>.",
      );
    }
    printQuestions(output);
    process.stdout.write("Re-run interactively or pass --answers <file> to continue.\n");
    return undefined;
  }

  throw new BspecError(
    `The plan still needs answers after ${MAX_ROUNDS} rounds. Please refine SPEC.md.`,
  );
}

async function loadAnswers(file?: string): Promise<ClarifyingAnswer[]> {
  if (!file) return [];
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new BspecError(`No answers file found at ${path}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new BspecError(`Answers file at ${path} is not valid JSON.`);
  }
  const result = answersFileSchema.safeParse(json);
  if (!result.success) {
    throw new BspecError(
      `Answers file at ${path} must be a JSON array of { "id", "answer" } objects.`,
    );
  }
  return result.data;
}

function printQuestions(output: PlannerOutput): void {
  process.stdout.write("\nThe plan needs a couple of answers before I can finish:\n");
  for (const q of output.questions) {
    process.stdout.write(`  ${q.id}. ${q.question}\n`);
    if (q.why) process.stdout.write(`      (why: ${q.why})\n`);
    for (const opt of q.options ?? []) {
      process.stdout.write(`      - ${opt.label}: ${opt.description}\n`);
    }
  }
}

function printReview(output: PlannerOutput): void {
  process.stdout.write("\nHere's the plan:\n");
  output.steps.forEach((step, i) => {
    const summary = step.summary ?? `Building ${step.id}`;
    process.stdout.write(`  ${i + 1}. ${summary}    ${step.id}@${step.version}\n`);
    for (const [name, value] of Object.entries(step.params)) {
      process.stdout.write(`        ${name}: ${JSON.stringify(value)}\n`);
    }
  });

  if (output.gaps.length > 0) {
    process.stdout.write(
      "\nNot covered by an installed block — bspec build will author each as a new block:\n",
    );
    for (const gap of output.gaps) {
      process.stdout.write(`  - ${gap.feature} — ${gap.reason}\n`);
    }
  }
  process.stdout.write("\n");
}

async function confirm(
  ask: (prompt: string) => Promise<string>,
  interactive: boolean,
): Promise<boolean> {
  if (!interactive) return false;
  const answer = (await ask("Write this plan? [y/N] ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function writePlan(
  project: string,
  specHash: string,
  output: PlannerOutput,
  planner: Planner,
  selector?: string,
): Promise<void> {
  const prov = planner.provenance?.();
  const planObject = {
    spec_hash: specHash,
    steps: output.steps,
    gaps: output.gaps,
    planner: {
      agent: prov?.agent ?? selector ?? "(default)",
      pi_version: prov?.pi_version ?? "unknown",
      planned_at: new Date().toISOString(),
    },
  };

  const bspecDir = join(project, ".bspec");
  await mkdir(bspecDir, { recursive: true });
  const planFile = join(bspecDir, "plan.json");
  await writeFile(planFile, JSON.stringify(planObject, null, 2) + "\n");

  process.stdout.write(`Wrote ${displayPath(planFile)}\n`);
  process.stdout.write(`Run: bspec build --project ${displayPath(project)}\n`);
}

async function writePlanLog(project: string, raw: string): Promise<string> {
  const logsDir = join(project, ".bspec", "logs");
  await mkdir(logsDir, { recursive: true });
  const logFile = join(logsDir, "plan.log");
  await writeFile(logFile, raw.endsWith("\n") ? raw : raw + "\n");
  return logFile;
}

function writeInfo(message: string): void {
  process.stdout.write(message + "\n");
}

/** A reusable line reader. Tests inject `ask`; real runs use one stdin readline. */
function makeAsker(injected?: (prompt: string) => Promise<string>): {
  ask: (prompt: string) => Promise<string>;
  close: () => void;
} {
  if (injected) return { ask: injected, close: () => {} };

  let rl: ReturnType<typeof createInterface> | undefined;
  return {
    ask: async (prompt: string) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return (await rl.question(prompt)).trim();
    },
    close: () => rl?.close(),
  };
}

function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  if (!rel || rel.startsWith("..")) return p;
  return rel;
}
