import { parseSelector, type ThinkingLevel } from "../agent.ts";
import { pickDefaultModel } from "../default-model.ts";
import { BspecError } from "../errors.ts";
import { loadPi, type PiModule } from "../pi.ts";
import type { PlannerProvenanceInfo } from "../planner.ts";
import type { Fixer, FixInput, FixResult } from "./fixer.ts";
import { isStuckEvents, type ToolEvent } from "./stuck.ts";

/**
 * The behavioral contract for the fixer, sent as the system prompt. The harness
 * — not the model — owns "done", so the contract is purely about *how* to edit:
 * smallest root-cause change, and never touch the tests (the diff-guard reverts
 * any iteration that does, so this is enforced, not merely requested).
 */
const FIXER_SYSTEM_PROMPT = `You are bspec's fix agent. A deterministic harness runs the build and test commands and decides when the work is done — you never declare success yourself. Your job each turn is to make the smallest code change that drives the current failing gate toward a clean exit.

Hard rules (the harness enforces these — any iteration that violates them is reverted wholesale):
- NEVER edit, delete, rename, skip, or weaken any test or spec file, test/spec directory, or test-runner config. Fix the implementation, not the tests.
- Do NOT hardcode return values to match a specific test, add skip/xfail/.only, weaken or delete assertions, or swallow failures.
- Diagnose the root cause first, then make the smallest change that addresses it. Do not refactor or touch unrelated code.

You have file tools (read/edit/write). You cannot run shell commands — the harness runs the gate for you after you stop. Make your edit, then stop.`;

export interface PiFixerOptions {
  /** Resolved model selector (`provider/id[:thinking]`); undefined → first available. */
  selector?: string;
  /** When true, allow the agent to run shell commands (bash tool stays enabled). */
  allowShell?: boolean;
  /** Optional progress sink (e.g. to announce the chosen default model). */
  onInfo?: (message: string) => void;
}

/** Minimal shape we read off Pi's message history to recover the final answer. */
interface AssistantContentPart {
  type: string;
  text?: string;
}
interface MessageLike {
  role: string;
  content?: AssistantContentPart[] | string;
}

/**
 * The real fixer: one fresh, tool-enabled, cwd-bound Pi session per iteration.
 * A fresh session each turn is deliberate — cross-iteration memory lives in the
 * on-disk ledger (injected via `triedSummary`), so the model's context stays
 * focused on the *current* failure (§5.6) instead of accumulating stale logs.
 *
 * Unlike bspec's planner/author (which are tool-less and isolated), this binds
 * `read/edit/write` to the project `cwd` and allows the project's context files
 * (AGENTS.md) to inform fixes; shell is excluded by default so the agent cannot
 * run — let alone spoof — the gate.
 */
export class PiFixer implements Fixer {
  private chosenAgent?: string;
  private piVersion?: string;

  constructor(private readonly opts: PiFixerOptions = {}) {}

  provenance(): PlannerProvenanceInfo {
    return {
      agent: this.chosenAgent ?? this.opts.selector ?? "(pi default)",
      pi_version: this.piVersion ?? "unknown",
    };
  }

  async fix(input: FixInput): Promise<FixResult> {
    const pi = await loadPi();
    this.piVersion = pi.VERSION;

    const authStorage = pi.AuthStorage.create();
    const modelRegistry = pi.ModelRegistry.create(authStorage);

    // The controller's current selector (set by the switch-model rung) wins over
    // the initially-configured one.
    const selector = input.model ?? this.opts.selector;
    const { model, thinkingLevel } = this.resolveModel(modelRegistry, selector);

    const loader = new pi.DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: pi.getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      // Allow project context (AGENTS.md, conventions) to inform fixes — our hard
      // rules still arrive via the system prompt + per-turn directive regardless.
      noContextFiles: false,
      systemPromptOverride: () => FIXER_SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const { session } = await pi.createAgentSession({
      model,
      thinkingLevel,
      // Bind the built-in file tools to the target project, not bspec's own cwd.
      cwd: input.cwd,
      // Default built-ins minus shell, unless explicitly allowed.
      ...(this.opts.allowShell ? {} : { excludeTools: ["bash"] }),
      authStorage,
      modelRegistry,
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(),
      settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false } }),
    });

    // Tap the event stream for mid-run stall detection (§6): abort a turn that
    // loops on the same tool actions before it burns the whole iteration.
    const events: ToolEvent[] = [];
    let aborted = false;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        events.push({ toolName: event.toolName, args: event.args });
        if (!aborted && isStuckEvents(events)) {
          aborted = true;
          void session.abort();
        }
      }
    });

    const tokensBefore = session.getSessionStats().tokens.total;
    try {
      await session.prompt(renderFixPrompt(input));
    } catch (err) {
      if (!aborted) throw err; // a real failure (auth/network), not our abort
    } finally {
      unsubscribe();
    }
    const tokensAfter = session.getSessionStats().tokens.total;

    const tokensUsed = Math.max(0, tokensAfter - tokensBefore);
    const text = finalAssistantText(session.messages as unknown as MessageLike[]);
    session.dispose();

    // Surface an empty turn loudly so the controller's no-op guard records a
    // clear reason instead of a mystery blank row (#4) — e.g. a model that can't
    // drive tool-enabled edits returns no output and burns no tokens.
    const summary = aborted
      ? "(aborted: mid-run tool loop detected)"
      : text || (tokensUsed === 0 ? "(model produced no output)" : "(no edits made)");

    return { tokensUsed, summary };
  }

  /** Resolve a selector to a Pi model that actually has valid auth (mirrors PiPlanner). */
  private resolveModel(
    registry: ReturnType<PiModule["ModelRegistry"]["create"]>,
    selector: string | undefined,
  ): { model: ReturnType<typeof registry.find>; thinkingLevel: ThinkingLevel } {
    const available = registry.getAvailable();

    if (!selector) {
      const model = pickDefaultModel(available);
      if (!model) throw new BspecError(NO_MODEL_MESSAGE);
      this.chosenAgent = `${model.provider}/${model.id}`;
      this.opts.onInfo?.(`No model configured; using ${this.chosenAgent}.`);
      return { model, thinkingLevel: "off" };
    }

    const { provider, id, thinking } = parseSelector(selector);
    const model = provider ? registry.find(provider, id) : available.find((m) => m.id === id);
    const isAvailable =
      model !== undefined &&
      available.some((m) => m.provider === model.provider && m.id === model.id);
    if (!model || !isAvailable) {
      throw new BspecError(
        `Model "${selector}" is not available in Pi. Run \`bspec config models\` to see options.`,
      );
    }

    this.chosenAgent = `${model.provider}/${model.id}`;
    return { model, thinkingLevel: thinking ?? "off" };
  }
}

const NO_MODEL_MESSAGE =
  "No usable model for `bspec fix`. Set BSPEC_AGENT (e.g. anthropic/claude-opus-4-8) and " +
  "authenticate it with Pi (`pi` then /login), or pass --agent.";

function renderFixPrompt(input: FixInput): string {
  return [
    `Phase: ${input.phase}. Drive this command to a clean (exit 0) result:`,
    `  ${input.gateCommand}`,
    "",
    "Current failure (fix only this — do not address anything else):",
    "",
    input.failureLog,
    "",
    `Already tried (do not repeat these): ${input.triedSummary}`,
    "",
    `Protected — never edit these: ${input.protectedGlobs.join(", ")}`,
    "",
    `Directive: ${input.directive}`,
  ].join("\n");
}

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
