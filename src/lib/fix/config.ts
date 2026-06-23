import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BspecError } from "../errors.ts";

/**
 * Globs the fixer must never touch — also enforced, unspoofably, by the
 * diff-guard. Covers the common test/spec layouts plus the runner configs whose
 * weakening would let a "fix" pass by gutting the gate rather than the code.
 */
export const DEFAULT_PROTECTED: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "tests/**",
  "spec/**",
  "**/conftest.py",
  "**/vitest.config.*",
  "**/jest.config.*",
];

/**
 * Directory/file *names* (matched at any depth, like `walk`) excluded from
 * working-tree snapshots and diff scans. `.bspec` holds the fixer's own state
 * (snapshots, ledger), so excluding it keeps snapshots from recursing into
 * themselves.
 */
export const DEFAULT_SNAPSHOT_IGNORE: readonly string[] = [
  ".git",
  "node_modules",
  ".bspec",
  ".DS_Store",
  "dist",
  ".next",
  "build",
];

export const DEFAULT_MAX_ITERS = 12;
export const DEFAULT_TOKEN_BUDGET = 2_000_000;
export const DEFAULT_BUILD_TIMEOUT_MS = 300_000;
export const DEFAULT_TEST_TIMEOUT_MS = 600_000;

/**
 * Schema for the on-disk `<project>/.bspec/fix.json`. Every field is optional:
 * build/test commands may instead arrive from CLI flags or a SPEC.md
 * `## Verification` section, so their presence is enforced after resolution
 * rather than here.
 */
export const fixConfigFileSchema = z.object({
  build: z.object({ cmd: z.string().min(1) }).optional(),
  test: z.object({ cmd: z.string().min(1) }).optional(),
  protected: z.array(z.string().min(1)).optional(),
  maxIters: z.number().int().positive().optional(),
  tokenBudget: z.number().int().positive().optional(),
  buildTimeoutMs: z.number().int().positive().optional(),
  testTimeoutMs: z.number().int().positive().optional(),
  allowShell: z.boolean().optional(),
  snapshotIgnore: z.array(z.string().min(1)).optional(),
});
export type FixConfigFile = z.infer<typeof fixConfigFileSchema>;

/** Fully-resolved config the controller runs against. */
export interface ResolvedFixConfig {
  readonly build: { readonly cmd: string };
  readonly test: { readonly cmd: string };
  readonly protected: readonly string[];
  readonly maxIters: number;
  readonly tokenBudget: number;
  readonly buildTimeoutMs: number;
  readonly testTimeoutMs: number;
  readonly allowShell: boolean;
  readonly snapshotIgnore: readonly string[];
}

/** CLI-flag overrides (highest precedence). */
export interface FixConfigOverrides {
  readonly buildCmd?: string;
  readonly testCmd?: string;
  readonly maxIters?: number;
  readonly tokenBudget?: number;
}

export function fixConfigPath(project: string): string {
  return join(project, ".bspec", "fix.json");
}

/**
 * Load and resolve the fix config for a project. Resolution per field:
 *   CLI flag → .bspec/fix.json → SPEC.md `## Verification` → built-in default.
 * Build and test commands have no default; their absence is a clear BspecError.
 */
export async function loadFixConfig(
  project: string,
  overrides: FixConfigOverrides = {},
): Promise<ResolvedFixConfig> {
  const file = fixConfigPath(project);
  const fileConfig = await readFixConfigFile(file);
  const spec = await readSpecVerification(project);

  const buildCmd = overrides.buildCmd ?? fileConfig.build?.cmd ?? spec.buildCmd;
  const testCmd = overrides.testCmd ?? fileConfig.test?.cmd ?? spec.testCmd;

  if (!buildCmd) throw new BspecError(missingCmdMessage("build", file));
  if (!testCmd) throw new BspecError(missingCmdMessage("test", file));

  return {
    build: { cmd: buildCmd },
    test: { cmd: testCmd },
    protected: fileConfig.protected ?? [...DEFAULT_PROTECTED],
    maxIters: overrides.maxIters ?? fileConfig.maxIters ?? DEFAULT_MAX_ITERS,
    tokenBudget: overrides.tokenBudget ?? fileConfig.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    buildTimeoutMs: fileConfig.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    testTimeoutMs: fileConfig.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
    allowShell: fileConfig.allowShell ?? false,
    snapshotIgnore: fileConfig.snapshotIgnore ?? [...DEFAULT_SNAPSHOT_IGNORE],
  };
}

/**
 * Extract build/test commands from a `## Verification` section of SPEC.md.
 * Recognized lines within that section (case-insensitive), e.g.:
 *   - build: `npm run build`
 *   - test: `npm test`
 * A lightweight, optional secondary source — anything it cannot parse is
 * simply absent and falls through to the next resolution tier.
 */
export function parseSpecVerification(spec: string): { buildCmd?: string; testCmd?: string } {
  const lines = spec.split("\n");

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+verification\b/i.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return {};

  const section: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i].trim())) break; // next heading ends the section
    section.push(lines[i]);
  }
  const text = section.join("\n");

  const extract = (key: "build" | "test"): string | undefined => {
    const re = new RegExp(`^\\s*[-*]?\\s*${key}\\s*:\\s*\`?([^\`\\n]+?)\`?\\s*$`, "im");
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };

  const result: { buildCmd?: string; testCmd?: string } = {};
  const buildCmd = extract("build");
  const testCmd = extract("test");
  if (buildCmd) result.buildCmd = buildCmd;
  if (testCmd) result.testCmd = testCmd;
  return result;
}

async function readFixConfigFile(file: string): Promise<FixConfigFile> {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  if (!raw.trim()) return {};

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BspecError(`Fix config at ${file} is not valid JSON.`);
  }
  const result = fixConfigFileSchema.safeParse(json);
  if (!result.success) {
    throw new BspecError(
      `Invalid fix config at ${file}: ${result.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return result.data;
}

async function readSpecVerification(
  project: string,
): Promise<{ buildCmd?: string; testCmd?: string }> {
  const specFile = join(project, "SPEC.md");
  if (!existsSync(specFile)) return {};
  try {
    return parseSpecVerification(await readFile(specFile, "utf8"));
  } catch {
    return {};
  }
}

function missingCmdMessage(which: "build" | "test", file: string): string {
  const flag = which === "build" ? "--build-cmd" : "--test-cmd";
  return (
    `No ${which} command found for \`bspec fix\`. ` +
    `Add { "${which}": { "cmd": "..." } } to ${file}, ` +
    `pass ${flag} <cmd>, or add a "## Verification" section to SPEC.md.`
  );
}
