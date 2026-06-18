import { parseSelector, type ThinkingLevel } from "./agent.ts";
import { BspecError } from "./errors.ts";
import { loadPi, type PiModule } from "./pi.ts";
import { validateRawOutput } from "./plan-validate.ts";
import {
  PlannerError,
  type BlockMenuEntry,
  type Planner,
  type PlannerInput,
  type PlannerProvenanceInfo,
} from "./planner.ts";
import type { PlannerOutput } from "./schemas.ts";

/** The behavioral contract sent as the planner's system prompt. */
const PLANNER_SYSTEM_PROMPT = `You are bspec's planner. Your only job is to turn a SPEC.md into a plan that selects from a fixed menu of prebuilt blocks. You are a picker, not a builder: you never write files, never run code, and only return plan data.

Rules:
- Select only blocks that appear in the provided menu. Never invent a block "id" or "version"; copy them verbatim from the menu and pin versions exactly.
- Fill each chosen block's "params" according to that block's parameter schema: include every "required" param, respect each param's "type" and "enum", and omit any param the block does not declare.
- Order steps sensibly (scaffolding before features). Set "needs" to [] for every step.
- If a spec feature matches no block in the menu, list it under "gaps" — do NOT approximate it with an unrelated block.
- If choosing a block or a parameter value would require a guess, ask under "questions" instead of guessing.
- Output ONLY a single JSON object with this shape, and nothing else (no prose, no code fences):
{
  "steps": [ { "id": "<menu id>", "version": "<menu version>", "summary": "<plain-English progress phrase>", "params": { }, "needs": [] } ],
  "gaps": [ { "feature": "<unmet wish>", "reason": "<why no block fits>" } ],
  "questions": [ { "id": "q1", "question": "<what you need to know>", "why": "<why it's ambiguous>" } ]
}`;

/** Minimal shape we read off Pi's message history to recover the final answer. */
interface AssistantContentPart {
  type: string;
  text?: string;
}
interface MessageLike {
  role: string;
  content?: AssistantContentPart[] | string;
}

export interface PiPlannerOptions {
  /** Resolved model selector (`provider/id[:thinking]`); undefined → first available. */
  selector?: string;
  /** Repair re-prompts allowed after the first attempt. Default 2. */
  maxRepairs?: number;
  /** Optional progress sink (e.g. to announce the chosen default model). */
  onInfo?: (message: string) => void;
}

/**
 * The real planner: one tool-less, in-memory Pi session per round. Disabling
 * tools (`noTools: "all"`), ambient context, extensions, and persistence keeps
 * planning isolated and enforces the picker-not-builder guarantee. The model's
 * raw text is never trusted — it passes through the validation pipeline, with
 * bounded repair, before a `PlannerOutput` is returned.
 */
export class PiPlanner implements Planner {
  private readonly maxRepairs: number;
  private chosenAgent?: string;
  private piVersion?: string;

  constructor(private readonly opts: PiPlannerOptions = {}) {
    this.maxRepairs = opts.maxRepairs ?? 2;
  }

  provenance(): PlannerProvenanceInfo {
    return {
      agent: this.chosenAgent ?? this.opts.selector ?? "(pi default)",
      pi_version: this.piVersion ?? "unknown",
    };
  }

  async plan(input: PlannerInput): Promise<PlannerOutput> {
    const pi = await loadPi();
    this.piVersion = pi.VERSION;

    const authStorage = pi.AuthStorage.create();
    const modelRegistry = pi.ModelRegistry.create(authStorage);

    const { model, thinkingLevel } = this.resolveModel(pi, modelRegistry);

    // Isolate planning from the user's global Pi setup: no ambient context
    // files, extensions, skills, prompts, or themes — just our system prompt.
    const loader = new pi.DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: pi.getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => PLANNER_SYSTEM_PROMPT,
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
      let prompt = renderUserPrompt(input);
      let lastRaw = "";
      for (let attempt = 0; attempt <= this.maxRepairs; attempt++) {
        await session.prompt(prompt);
        lastRaw = finalAssistantText(session.messages as unknown as MessageLike[]);
        const result = validateRawOutput(lastRaw, input.menu);
        if (result.ok) return result.output;
        prompt = renderRepairPrompt(result.message);
      }
      const attempts = this.maxRepairs + 1;
      throw new PlannerError(
        `The planner did not return a usable plan after ${attempts} attempts.`,
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
      if (available.length === 0) {
        throw new BspecError(NO_MODEL_MESSAGE);
      }
      const model = available[0];
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

/** Recover the final assistant text by concatenating its text parts. */
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

function renderUserPrompt(input: PlannerInput): string {
  const menu = JSON.stringify(input.menu, null, 2);
  const parts = [
    "Here is the project's SPEC.md:",
    "",
    input.spec,
    "",
    "Here is the menu of installed blocks you may choose from:",
    "",
    menu,
  ];
  if (input.answers && input.answers.length > 0) {
    parts.push(
      "",
      "Answers to your earlier clarifying questions:",
      ...input.answers.map((a) => `- [${a.id}] ${a.answer}`),
    );
  }
  parts.push(
    "",
    "Return the single JSON plan object now, following the rules in your instructions.",
  );
  return parts.join("\n");
}

function renderRepairPrompt(problem: string): string {
  return (
    `That output was not usable: ${problem}\n\n` +
    "Return a corrected single JSON object only — no prose, no code fences."
  );
}
