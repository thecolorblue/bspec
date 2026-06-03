import path from "node:path";
import chalk from "chalk";
import { input, select } from "@inquirer/prompts";
import fs from "fs-extra";
import { ProviderRuntimeConfig } from "./auth.js";
import { runPi } from "./pi-runner.js";
import { SessionLog } from "./session-log.js";
import { readPlanSteps } from "./plan-parser.js";
import { PlanStep, ResolvedSpec, SpecFile } from "./types.js";
import { runCommandCapture } from "./utils/process.js";
import { ExecuteDisplay, supportsUnicode } from "./live-display.js";

const PLAN_SYSTEM_PROMPT = `You are in PLANNING mode for a SPEC-driven build.
- Read the SPEC carefully (supplied below as a @file).
- Produce ONLY a file named PLAN.md in the current working directory.
- The plan MUST be a markdown document with a top-level "# Plan" heading
  and a numbered list under a "## Steps" heading.
- Each numbered step MUST be self-contained, executable in isolation,
  and named so a developer (or another agent) can pick it up and run it.
- Do NOT write any source code, do NOT modify any other files.
- After writing PLAN.md, stop.`;

function executePrompt(stepNumber: number, stepText: string): string {
  return `You are in EXECUTE mode for step ${stepNumber} of the build plan.
- The full plan lives at ./PLAN.md for context. Re-read if needed.
- Your scope for THIS invocation is ONLY step ${stepNumber}, reproduced verbatim:
${indentBlock(stepText.trim(), 4)}
- Implement that step end-to-end. Do not start the next step.
- When done, briefly summarize what you changed and stop.`;
}

function repairPrompt(issue: string): string {
  return `You are in REPAIR mode for the app built in output_dir.
- The user has reported an error or issue, reproduced verbatim below.
- Your scope for THIS invocation is ONLY the reported issue.
- Investigate the symptom, locate the cause in the source files, and fix it.
- Do NOT refactor unrelated code or add unrequested features.
- After fixing the issue, update the SPEC.md in output_dir to reflect what changed:
    - If the fix revealed a missing requirement, add it under the relevant section.
    - If the fix corrected a misspecified behavior, amend the relevant description.
    - If the fix was purely a bug (typo, off-by-one, wrong API call) with no spec
      implication, add a brief note under a "## Known Fixes" section at the end
      of the SPEC.md so future rebuilds avoid the same mistake.
    - Do NOT restructure or rewrite the spec; make the smallest accurate update.
- When done, briefly summarize what you changed in the source AND what you
  updated in SPEC.md, then stop.`;
}

export interface OrchestrateOptions {
  spec: SpecFile;
  resolvedSpec: ResolvedSpec;
  providerConfig: ProviderRuntimeConfig;
  model: string;
  skipRepair?: boolean;
  autoApprove?: boolean;
}

export interface OrchestrateResult {
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
}

export async function orchestrateBuild(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const session = await SessionLog.create({
    provider: options.providerConfig.provider,
    model: options.model,
    specPath: options.spec.path,
    outputDir: options.resolvedSpec.output_dir,
  });

  const resolvedSpecPath = await session.writeResolvedSpec(options.resolvedSpec.resolved_markdown);

  await session.updateSummary({ status: "planning" });

  console.log(chalk.cyan("Planning the build..."));
  const planResult = await runPi({
    session,
    provider: options.providerConfig,
    model: options.model,
    sessionId: session.id,
    resolvedSpecPath,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    instruction: "Read the attached spec and produce PLAN.md.",
    cwd: options.resolvedSpec.output_dir,
  });

  if (planResult.exitCode !== 0) {
    await session.updateSummary({ status: "failed", error: "Plan phase failed." });
    console.error(chalk.red("Plan phase failed. See logs for details."));
    await session.close();
    return { sessionId: session.id, status: "failed" };
  }

  const planPath = path.join(options.resolvedSpec.output_dir, "PLAN.md");
  if (!(await fs.pathExists(planPath))) {
    await session.updateSummary({ status: "failed", error: "PLAN.md not produced." });
    await session.close();
    throw new Error(`pi did not produce PLAN.md in ${options.resolvedSpec.output_dir}`);
  }

  await session.updateSummary({ status: "awaiting_approval" });

  let planSteps = await readPlanSteps(planPath);
  if (planSteps.length === 0) {
    await session.updateSummary({ status: "failed", error: "PLAN.md contained no steps." });
    await session.close();
    throw new Error("PLAN.md did not contain any steps under ## Steps.");
  }

  if (!options.autoApprove) {
    let approved = false;
    while (!approved) {
      console.log(chalk.gray(`PLAN.md contains ${planSteps.length} step(s). Path: ${planPath}`));
      const choice = await select({
        message: "Approve the plan?",
        choices: [
          { value: "approve", name: "Approve plan" },
          { value: "edit", name: "Edit PLAN.md then re-parse" },
          { value: "abort", name: "Abort build" },
        ],
      });
      if (choice === "approve") {
        approved = true;
        break;
      }
      if (choice === "abort") {
        await session.updateSummary({ status: "cancelled", error: "User aborted after plan phase." });
        console.log(chalk.yellow("Build aborted by user."));
        await session.close();
        return { sessionId: session.id, status: "cancelled" };
      }
      if (choice === "edit") {
        console.log(chalk.gray(`Edit PLAN.md at ${planPath} and save changes.`));
        await input({ message: "Press Enter after saving PLAN.md to re-parse." });
        planSteps = await readPlanSteps(planPath);
        if (planSteps.length === 0) {
          console.warn(chalk.red("PLAN.md still contains no steps. Please add at least one step."));
        }
      }
    }
  }

  await session.updateSummary({ status: "executing", stepCount: planSteps.length });

  const useDisplay = Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
  const executeDisplay = useDisplay
    ? new ExecuteDisplay({
        totalSteps: planSteps.length,
        useUnicode: supportsUnicode(),
        stream: process.stdout,
      })
    : null;

  for (let idx = 0; idx < planSteps.length; idx++) {
    const step = planSteps[idx]!;
    const summary = summariseStep(step);
    await session.appendAgentEvent({
      kind: "checkpoint",
      payload: { phase: "execute", step: step.index, boundary: "pre-step", summary },
    });
    if (executeDisplay) {
      executeDisplay.startStep(idx + 1, summary);
    } else {
      console.log(chalk.cyan(`Executing step ${step.index}/${planSteps.length}: ${summary}`));
    }
    const executeResult = await runPi({
      session,
      provider: options.providerConfig,
      model: options.model,
      sessionId: session.id,
      resolvedSpecPath,
      systemPrompt: executePrompt(step.index, step.text),
      instruction: `Execute step ${step.index} from PLAN.md.`,
      cwd: options.resolvedSpec.output_dir,
      onEvent: executeDisplay
        ? (event) => {
            executeDisplay.handlePiEvent(event);
          }
        : undefined,
    });
    if (executeResult.exitCode !== 0) {
      await session.updateSummary({
        status: "failed",
        error: `Execute phase failed on step ${step.index}`,
      });
      executeDisplay?.failStep(`Step ${step.index} failed`);
      executeDisplay?.finalize("failed", `Step ${step.index}`);
      console.error(chalk.red(`Step ${step.index} failed. See logs for diagnostics.`));
      await session.close();
      return { sessionId: session.id, status: "failed" };
    }

    const gitCommit = await attemptGitCheckpoint(options.resolvedSpec.output_dir, step);
    await session.appendAgentEvent({
      kind: "checkpoint",
      payload: {
        phase: "execute",
        step: step.index,
        boundary: "post-step",
        summary,
        gitCommit: gitCommit ?? undefined,
      },
    });
    executeDisplay?.completeStep();
  }

  executeDisplay?.finalize("completed");

  if (options.skipRepair) {
    await session.updateSummary({ status: "completed" });
    console.log(chalk.green("Build completed without repair loop."));
    await session.close();
    return { sessionId: session.id, status: "completed" };
  }

  await session.updateSummary({ status: "repair" });
  console.log(chalk.cyan("Entering repair loop. Leave blank to finish."));
  let issueCount = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const issue = (await input({
      message: "Describe an issue to repair (or press Enter to finish):",
    })).trim();
    if (!issue) {
      break;
    }
    issueCount += 1;
    await session.appendAgentEvent({
      kind: "checkpoint",
      payload: { phase: "repair", issue_seq: issueCount, summary: issue.slice(0, 120) },
    });
    const repairResult = await runPi({
      session,
      provider: options.providerConfig,
      model: options.model,
      sessionId: session.id,
      resolvedSpecPath,
      systemPrompt: repairPrompt(issue),
      instruction: issue,
      cwd: options.resolvedSpec.output_dir,
    });
    if (repairResult.exitCode !== 0) {
      console.error(chalk.red("Repair step failed. See logs for details."));
    }
  }

  await session.updateSummary({ status: "completed" });
  console.log(chalk.green("Build completed."));
  await session.close();
  return { sessionId: session.id, status: "completed" };
}

function summariseStep(step: PlanStep): string {
  const firstLine = step.text.split("\n")[0] ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

async function attemptGitCheckpoint(cwd: string, step: PlanStep): Promise<{ sha: string; message: string } | null> {
  const inside = await runCommandCapture("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return null;
  }

  const status = await runCommandCapture("git", ["status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) {
    return null;
  }

  await runCommandCapture("git", ["add", "-A"], { cwd });
  const message = formatCommitMessage(step);
  await runCommandCapture("git", ["commit", "-m", message], { cwd });
  const rev = await runCommandCapture("git", ["rev-parse", "HEAD"], { cwd });
  return {
    sha: rev.stdout.trim(),
    message,
  };
}

function formatCommitMessage(step: PlanStep): string {
  const summary = summariseStep(step);
  const base = `Step ${step.index}: ${summary}`;
  return base.length > 72 ? `${base.slice(0, 69)}...` : base;
}

function indentBlock(text: string, indent: number): string {
  const prefix = " ".repeat(indent);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
