import { loadConfig, resolveBspecHome } from "../config.ts";
import { BspecError } from "./errors.ts";

/** Pi thinking levels, accepted as an optional `:<level>` selector suffix. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ParsedSelector {
  /** Provider name, e.g. "anthropic". Undefined for a bare model id. */
  provider?: string;
  /** Model id. May itself contain "/" (e.g. OpenRouter ids). */
  id: string;
  /** Optional thinking level parsed from a ":<level>" suffix. */
  thinking?: ThinkingLevel;
}

/**
 * Parse a Pi model selector. Forms:
 *   "anthropic/claude-opus-4-5"
 *   "anthropic/claude-opus-4-5:high"        (thinking suffix)
 *   "openrouter/anthropic/claude-3.5-sonnet" (id keeps inner slashes)
 *   "gpt-4o"                                  (bare id, no provider)
 */
export function parseSelector(selector: string): ParsedSelector {
  const trimmed = selector.trim();
  if (!trimmed) throw new BspecError("Model selector is empty.");

  // Split an optional ":<thinking>" suffix, but only when it names a known
  // level — model ids may legitimately contain a colon.
  let model = trimmed;
  let thinking: ThinkingLevel | undefined;
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1) {
    const maybe = trimmed.slice(colon + 1);
    if ((THINKING_LEVELS as readonly string[]).includes(maybe)) {
      thinking = maybe as ThinkingLevel;
      model = trimmed.slice(0, colon);
    }
  }

  // The first "/" separates provider from id; the id may contain further "/".
  const slash = model.indexOf("/");
  let provider: string | undefined;
  let id: string;
  if (slash === -1) {
    id = model;
  } else {
    provider = model.slice(0, slash);
    id = model.slice(slash + 1);
    if (!provider) {
      throw new BspecError(`Invalid model selector "${selector}": missing provider.`);
    }
  }
  if (!id) {
    throw new BspecError(`Invalid model selector "${selector}": missing model id.`);
  }

  return { provider, id, thinking };
}

export type AgentSource = "flag" | "env" | "file" | "default";

/** Human-readable label for where a resolved agent selector came from. */
export function agentSourceLabel(source: AgentSource): string {
  switch (source) {
    case "flag":
      return "from --agent";
    case "env":
      return "from $BSPEC_AGENT";
    case "file":
      return "from config.json";
    case "default":
      return "default";
  }
}

export interface ResolvedAgent {
  /** The selector string, or undefined to let Pi choose a default model. */
  selector?: string;
  source: AgentSource;
}

/**
 * Resolve which planner model to use, highest priority first:
 *   1. `--agent` flag   2. $BSPEC_AGENT   3. config.json `agent`   4. default
 */
export async function resolveAgentSelector(
  opts: { flag?: string; env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<ResolvedAgent> {
  const env = opts.env ?? process.env;

  const flag = opts.flag?.trim();
  if (flag) return { selector: flag, source: "flag" };

  const envAgent = env.BSPEC_AGENT?.trim();
  if (envAgent) return { selector: envAgent, source: "env" };

  const config = await loadConfig(opts.home ?? resolveBspecHome(env));
  if (config.agent) return { selector: config.agent, source: "file" };

  return { selector: undefined, source: "default" };
}
