import { parseSelector, type ThinkingLevel } from "./agent.ts";
import {
  BlockAuthorError,
  parseAuthorOutput,
  validateAuthoredBlock,
  type BlockAuthor,
  type BlockAuthorInput,
} from "./block-author.ts";
import { pickDefaultModel } from "./default-model.ts";
import { BspecError } from "./errors.ts";
import { loadPi, type PiModule } from "./pi.ts";
import type { PlannerProvenanceInfo } from "./planner.ts";
import type { BlockAuthorOutput } from "./schemas.ts";

/** The behavioral contract sent as the author's system prompt. */
const BLOCK_AUTHOR_SYSTEM_PROMPT = `You are bspec's block author. Your job is to write ONE self-contained, executable block that fills a single missing feature ("gap") in an app plan. You never run code; you only return block source as JSON.

A bspec block is a single Bun-executable TypeScript file that implements this exact command contract, with NO imports from bspec (only the Node/Bun standard library):
- "--manifest": print the block's manifest as JSON to stdout and exit 0.
- "--apply <out_dir> <params.json>": write the produced files under <out_dir>, reading parameter VALUES from the JSON file (which may be absent — fall back to sensible defaults). Exit 0.
- "--test": run an in-memory self-test (apply into a temp dir, assert the output is correct) and exit 0 on success, non-zero on failure.

The manifest is an object: { "id", "version", "summary", "params": { <name>: { "type": "string"|"number"|"boolean"|"enum", "required": bool, "description"?, "enum"?, "default"? } }, "produces": [<relative file paths>], "needs": [] }.

Rules:
- Choose an "id" that is a short kebab-case slug and is NOT in the provided "takenIds". Use version "1.0.0".
- Do NOT produce any file path listed in "takenProduces"; pick distinct paths so the block composes with the rest of the app.
- Keep params minimal; every "required" param must be filled by the "step.params" you return, and every param you set must be declared in the manifest with a matching type.
- The block must be fully self-contained and must pass its own "--test".
- Output ONLY a single JSON object, no prose and no code fences, with this shape:
{
  "block": { "source": "<the entire .block.ts file as a string>" },
  "step": { "id": "<manifest id>", "version": "<manifest version>", "summary": "<plain-English progress phrase>", "params": { }, "needs": [] }
}`;

interface AssistantContentPart {
  type: string;
  text?: string;
}
interface MessageLike {
  role: string;
  content?: AssistantContentPart[] | string;
}

export interface PiBlockAuthorOptions {
  /** Resolved model selector (`provider/id[:thinking]`); undefined → first available. */
  selector?: string;
  /** Repair re-prompts allowed after the first attempt. Default 2. */
  maxRepairs?: number;
  /** Optional progress sink (e.g. to announce the chosen default model). */
  onInfo?: (message: string) => void;
}

/**
 * The real block author: one tool-less, in-memory Pi session per gap. Mirrors
 * `PiPlanner` — disabling tools, ambient context, extensions, and persistence
 * keeps authoring isolated. The model's raw text is never trusted: it passes
 * through `parseAuthorOutput` + `validateAuthoredBlock` (which runs the block's
 * own `--manifest`/`--test`), with bounded repair, before a usable
 * `BlockAuthorOutput` is returned.
 */
export class PiBlockAuthor implements BlockAuthor {
  private readonly maxRepairs: number;
  private chosenAgent?: string;
  private piVersion?: string;

  constructor(private readonly opts: PiBlockAuthorOptions = {}) {
    this.maxRepairs = opts.maxRepairs ?? 2;
  }

  provenance(): PlannerProvenanceInfo {
    return {
      agent: this.chosenAgent ?? this.opts.selector ?? "(pi default)",
      pi_version: this.piVersion ?? "unknown",
    };
  }

  async author(input: BlockAuthorInput): Promise<BlockAuthorOutput> {
    const pi = await loadPi();
    this.piVersion = pi.VERSION;

    const authStorage = pi.AuthStorage.create();
    const modelRegistry = pi.ModelRegistry.create(authStorage);
    const { model, thinkingLevel } = this.resolveModel(pi, modelRegistry);

    const loader = new pi.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: pi.getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => BLOCK_AUTHOR_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session } = await pi.createAgentSession({
      model,
      thinkingLevel,
      noTools: "all",
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(),
      settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false } }),
    });

    try {
      let prompt = renderAuthorPrompt(input);
      let lastRaw = "";
      for (let attempt = 0; attempt <= this.maxRepairs; attempt++) {
        await session.prompt(prompt);
        lastRaw = finalAssistantText(session.messages as unknown as MessageLike[]);

        const parsed = parseAuthorOutput(lastRaw);
        if (!parsed.ok) {
          prompt = renderRepairPrompt(parsed.message);
          continue;
        }
        const validation = await validateAuthoredBlock(parsed.output, input);
        if (validation.ok) return parsed.output;
        prompt = renderRepairPrompt(validation.message);
      }
      const attempts = this.maxRepairs + 1;
      throw new BlockAuthorError(
        `The author did not return a usable block after ${attempts} attempts.`,
        { rawOutput: lastRaw, attempts },
      );
    } finally {
      session.dispose();
    }
  }

  /** Resolve the selector to a Pi model that actually has valid auth. */
  private resolveModel(
    pi: PiModule,
    registry: ReturnType<PiModule["ModelRegistry"]["create"]>,
  ): { model: ReturnType<typeof registry.find>; thinkingLevel: ThinkingLevel } {
    const available = registry.getAvailable();

    if (!this.opts.selector) {
      const model = pickDefaultModel(available);
      if (!model) throw new BspecError(NO_MODEL_MESSAGE);
      this.chosenAgent = `${model.provider}/${model.id}`;
      this.opts.onInfo?.(`No model configured; using ${this.chosenAgent}.`);
      return { model, thinkingLevel: "off" };
    }

    const { provider, id, thinking } = parseSelector(this.opts.selector);
    const model = provider ? registry.find(provider, id) : available.find((m) => m.id === id);
    const isAvailable =
      model !== undefined &&
      available.some((m) => m.provider === model.provider && m.id === model.id);
    if (!model || !isAvailable) {
      throw new BspecError(
        `Model "${this.opts.selector}" is not available in Pi. ` +
          "Run `bspec config models` to see options.",
      );
    }

    this.chosenAgent = `${model.provider}/${model.id}`;
    return { model, thinkingLevel: thinking ?? "off" };
  }
}

const NO_MODEL_MESSAGE =
  "No usable model. Set BSPEC_AGENT (e.g. anthropic/claude-opus-4-5) and " +
  "authenticate it with Pi (`pi` then /login), or run `bspec config models`.";

function finalAssistantText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function renderAuthorPrompt(input: BlockAuthorInput): string {
  return [
    "Write one block to fill this gap in the app:",
    "",
    `Feature: ${input.gap.feature}`,
    `Why no existing block fits: ${input.gap.reason}`,
    "",
    "Project SPEC.md (for context on what the block should do):",
    "",
    input.spec,
    "",
    `Block ids already in use (do NOT reuse): ${JSON.stringify(input.takenIds)}`,
    `File paths already produced by other steps (do NOT produce these): ${JSON.stringify(
      input.takenProduces,
    )}`,
    "",
    "Return the single JSON object now, following the rules in your instructions.",
  ].join("\n");
}

function renderRepairPrompt(problem: string): string {
  return (
    `That output was not usable: ${problem}\n\n` +
    "Return a corrected single JSON object only — no prose, no code fences."
  );
}
