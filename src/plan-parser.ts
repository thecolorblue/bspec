import fs from "fs-extra";
import { PlanStep } from "./types.js";

const STEP_REGEX = /^\s*(\d+)[\.\)]\s+(.*)$/;
const HEADING_REGEX = /^\s*##\s+/;

export async function readPlanSteps(planPath: string): Promise<PlanStep[]> {
  const raw = await fs.readFile(planPath, "utf8");
  const lines = raw.split(/\r?\n/);

  let inSteps = false;
  const steps: PlanStep[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!inSteps) {
      if (line.trim().toLowerCase() === "## steps") {
        inSteps = true;
      }
      continue;
    }

    if (HEADING_REGEX.test(line) && line.trim().toLowerCase() !== "## steps") {
      break;
    }

    const match = line.match(STEP_REGEX);
    if (match) {
      const number = Number.parseInt(match[1]!, 10);
      const text = match[2]!.trim();
      steps.push({ index: number, text });
      continue;
    }

    if (line.trim().length === 0) {
      continue;
    }

    if (steps.length === 0) {
      continue;
    }

    const last = steps[steps.length - 1];
    last.text = `${last.text}\n${line.trim()}`;
  }

  return steps;
}
