import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockPath, blocksDir } from "../config.ts";
import { loadManifest, runBlock } from "./blocks.ts";
import { BspecError } from "./errors.ts";
import { extractJsonObject, checkRegistry } from "./plan-validate.ts";
import type { BlockMenuEntry, PlannerProvenanceInfo } from "./planner.ts";
import {
  blockAuthorOutputSchema,
  type BlockAuthorOutput,
  type PlanGap,
  type PlannerStep,
} from "./schemas.ts";

/** Input handed to a block author to fill one plan gap. */
export interface BlockAuthorInput {
  /** The unmet wish, copied from the plan's `gaps`. */
  gap: PlanGap;
  /** Full SPEC.md text, for context on what the block should do. */
  spec: string;
  /** Block ids already installed or planned — the new block must not reuse one. */
  takenIds: string[];
  /** Output paths already produced by other steps — the new block must not clobber one. */
  takenProduces: string[];
}

/**
 * The second AI step in bspec (the first is the planner). An author turns a gap
 * into the source of a self-contained, tested `.block.ts`. The real
 * implementation (`PiBlockAuthor`) wraps Pi; tests inject a deterministic fake.
 */
export interface BlockAuthor {
  author(input: BlockAuthorInput): Promise<BlockAuthorOutput>;
  /** Optional: describe the model that authored the most recent block. */
  provenance?(): PlannerProvenanceInfo | undefined;
}

/**
 * Raised when an author cannot return a usable block (its output failed
 * validation after the repair budget). Carries the raw model output so `build`
 * can persist it for inspection.
 */
export class BlockAuthorError extends BspecError {
  readonly rawOutput?: string;
  readonly attempts?: number;

  constructor(message: string, opts: { rawOutput?: string; attempts?: number } = {}) {
    super(message);
    this.name = "BlockAuthorError";
    this.rawOutput = opts.rawOutput;
    this.attempts = opts.attempts;
  }
}

/** Result of validating an authored block against the contract and the gap. */
export type AuthorValidation =
  | { ok: true; step: PlannerStep; source: string; produces: string[] }
  | { ok: false; message: string };

/**
 * Raw model text → shape-valid `BlockAuthorOutput` (extract JSON, parse, schema
 * check). Does NOT execute the block — see `validateAuthoredBlock`.
 */
export function parseAuthorOutput(
  raw: string,
): { ok: true; output: BlockAuthorOutput } | { ok: false; message: string } {
  const json = extractJsonObject(raw);
  if (json === null) {
    return { ok: false, message: "The author did not return a JSON object." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, message: "The author's output was not valid JSON." };
  }
  const result = blockAuthorOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".");
    const where = path ? ` (at ${path})` : "";
    return {
      ok: false,
      message: `The author's output did not match the required shape${where}: ${
        issue?.message ?? "unknown error"
      }.`,
    };
  }
  return { ok: true, output: result.data };
}

/**
 * The trust boundary for authored blocks. Runs the candidate block in a temp
 * dir and confirms, in order, that it: declares a manifest matching the invoking
 * step (id + version); produces at least one file and none that collide with
 * another step's outputs; accepts the step's params per its own schema; and
 * passes its own `--test`. Returns the validated step or a single plain-English
 * message suitable both as a user-facing error and a repair instruction.
 *
 * No matter what model authored the block, nothing is installed until it clears
 * this gate — the analogue of `checkRegistry` for the picker path.
 */
export async function validateAuthoredBlock(
  output: BlockAuthorOutput,
  input: BlockAuthorInput,
): Promise<AuthorValidation> {
  const { block, step } = output;

  if (input.takenIds.includes(step.id)) {
    return {
      ok: false,
      message: `Block id "${step.id}" is already in use; choose a new, unique id.`,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "bspec-author-"));
  try {
    const file = join(dir, `${step.id}.block.ts`);
    await writeFile(file, block.source);

    let manifest;
    try {
      manifest = await loadManifest(file);
    } catch (err) {
      return {
        ok: false,
        message: `The block's --manifest did not run or was invalid: ${messageOf(err)}`,
      };
    }

    if (manifest.id !== step.id) {
      return {
        ok: false,
        message: `The block's manifest id "${manifest.id}" must match the step id "${step.id}".`,
      };
    }
    if (manifest.version !== step.version) {
      return {
        ok: false,
        message:
          `The block's manifest version "${manifest.version}" must match the step ` +
          `version "${step.version}".`,
      };
    }
    if (manifest.produces.length === 0) {
      return { ok: false, message: "The block must produce at least one file." };
    }
    for (const path of manifest.produces) {
      if (input.takenProduces.includes(path)) {
        return {
          ok: false,
          message: `The block would overwrite "${path}", which another step already produces.`,
        };
      }
    }

    // Reuse the picker-path param validator: a one-entry menu + one-step plan.
    const menuEntry: BlockMenuEntry = {
      id: manifest.id,
      version: manifest.version,
      summary: manifest.summary,
      params: manifest.params,
      produces: manifest.produces,
    };
    const semantic = checkRegistry({ steps: [step], gaps: [], questions: [] }, [menuEntry]);
    if (semantic) return { ok: false, message: semantic };

    const test = await runBlock(file, ["--test"]);
    if (test.code !== 0) {
      const detail = (test.stderr.trim() || test.stdout.trim()).split("\n")[0] ?? "";
      return { ok: false, message: `The block's self-test (--test) failed: ${detail}` };
    }

    return { ok: true, step, source: block.source, produces: manifest.produces };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Install a validated block's source into the registry; returns its path. */
export async function installAuthoredBlock(
  source: string,
  id: string,
  home: string,
): Promise<string> {
  await mkdir(blocksDir(home), { recursive: true });
  const dest = blockPath(id, home);
  await writeFile(dest, source, { mode: 0o755 });
  return dest;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}
