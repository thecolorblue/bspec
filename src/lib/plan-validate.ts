import type { BlockMenuEntry } from "./planner.ts";
import {
  plannerOutputSchema,
  type ParamSpec,
  type PlannerOutput,
  type PlannerStep,
} from "./schemas.ts";

/**
 * Result of validating raw planner text (or a planner output object) against the
 * live block registry. A failure carries a single plain-English message that is
 * good both as a user-facing error and as a repair instruction back to the model.
 */
export type ValidationResult =
  | { ok: true; output: PlannerOutput }
  | { ok: false; message: string };

/**
 * Extract the single top-level JSON object from raw model text. Strips an
 * optional ```/```json code fence, then brace-matches from the first `{` to its
 * partner, ignoring braces inside string literals. Returns null when no object
 * is present.
 */
export function extractJsonObject(raw: string): string | null {
  const unfenced = stripCodeFence(raw.trim());
  const start = unfenced.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return unfenced.slice(start, i + 1);
    }
  }
  return null;
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : text;
}

/**
 * Raw model text → shape-valid `PlannerOutput` (extract JSON, parse, schema
 * check). Does NOT check the output against the registry — see `checkRegistry`.
 */
export function parsePlannerOutput(raw: string): ValidationResult {
  const json = extractJsonObject(raw);
  if (json === null) {
    return { ok: false, message: "The planner did not return a JSON object." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: "The planner's output was not valid JSON." };
  }

  const result = plannerOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".");
    const where = path ? ` (at ${path})` : "";
    return {
      ok: false,
      message: `The planner's output did not match the required shape${where}: ${
        issue?.message ?? "unknown error"
      }.`,
    };
  }

  return { ok: true, output: result.data };
}

/**
 * Semantic validation against the installed registry. For every step: the block
 * id must be installed, the version must match exactly, and the filled params
 * must conform to that block's parameter schema. Returns the first error message
 * (suitable for repair) or null when the output is fully valid.
 *
 * This is the trust boundary that makes "the AI is a picker" a guarantee: no
 * matter what the model says, a plan can only reference real blocks with valid
 * params.
 */
export function checkRegistry(output: PlannerOutput, menu: BlockMenuEntry[]): string | null {
  const byId = new Map(menu.map((entry) => [entry.id, entry]));

  for (const step of output.steps) {
    const block = byId.get(step.id);
    if (!block) {
      const available = menu.map((e) => `${e.id}@${e.version}`).join(", ") || "(none)";
      return (
        `The planner chose "${step.id}@${step.version}", which isn't installed. ` +
        `Available: ${available}.`
      );
    }
    if (block.version !== step.version) {
      return (
        `The planner chose "${step.id}@${step.version}", but the installed version ` +
        `is ${block.version}. Pin the version exactly as listed in the menu.`
      );
    }
    const paramError = checkParams(step, block.params);
    if (paramError) return paramError;
  }

  return null;
}

function checkParams(step: PlannerStep, schema: Record<string, ParamSpec>): string | null {
  // No unknown params.
  for (const name of Object.keys(step.params)) {
    if (!(name in schema)) {
      return `The planner set "${name}" on "${step.id}", which doesn't accept it.`;
    }
  }

  // Required present + each value well-typed.
  for (const [name, spec] of Object.entries(schema)) {
    const has = name in step.params;
    if (!has) {
      if (spec.required) return `"${step.id}" requires "${name}".`;
      continue;
    }
    const typeError = checkParamType(step.id, name, spec, step.params[name]);
    if (typeError) return typeError;
  }

  return null;
}

function checkParamType(
  id: string,
  name: string,
  spec: ParamSpec,
  value: unknown,
): string | null {
  switch (spec.type) {
    case "string":
    case "number":
    case "boolean":
      if (typeof value !== spec.type) {
        return `The planner set "${name}" on "${id}" to the wrong type (expected ${spec.type}).`;
      }
      return null;
    case "enum":
      if (typeof value !== "string" || !(spec.enum ?? []).includes(value)) {
        const allowed = (spec.enum ?? []).map((v) => `"${v}"`).join(", ");
        return `The planner set "${name}" on "${id}" to a value that is not one of: ${allowed}.`;
      }
      return null;
  }
}

/**
 * Full pipeline: raw model text → trusted `PlannerOutput`, validated against the
 * registry. Used by `PiPlanner` (with bounded repair on failure) and exercised
 * directly by the unit tests.
 */
export function validateRawOutput(raw: string, menu: BlockMenuEntry[]): ValidationResult {
  const parsed = parsePlannerOutput(raw);
  if (!parsed.ok) return parsed;

  const semantic = checkRegistry(parsed.output, menu);
  if (semantic) return { ok: false, message: semantic };

  return { ok: true, output: parsed.output };
}
