/** The minimal model shape needed to choose a default — just provider + id. */
export interface ModelIdentity {
  provider: string;
  id: string;
}

/**
 * Ordered preferences for the planner/author default model when the user has not
 * configured one. Pi lists its built-in models with the long-deprecated
 * `claude-3-5-haiku-20241022` first, so blindly taking `getAvailable()[0]` opts
 * everyone into a model the Anthropic API actively warns is end-of-life. Prefer
 * current Claude 4 tiers (cheap → capable) and only fall back to Pi's own
 * ordering when the user has authenticated some other provider entirely.
 */
const DEFAULT_PREFERENCES: ReadonlyArray<(model: ModelIdentity) => boolean> = [
  (m) => m.provider === "anthropic" && /(^|-)haiku-4(-|$)/.test(m.id),
  (m) => m.provider === "anthropic" && /(^|-)sonnet-4(-|$)/.test(m.id),
  (m) => m.provider === "anthropic" && /(^|-)opus-4(-|$)/.test(m.id),
];

/**
 * Choose a default model from those Pi reports as available (auth configured),
 * preferring current models over Pi's deprecated-first ordering. Returns
 * undefined only when nothing is available.
 */
export function pickDefaultModel<M extends ModelIdentity>(
  available: readonly M[],
): M | undefined {
  for (const matches of DEFAULT_PREFERENCES) {
    const hit = available.find(matches);
    if (hit) return hit;
  }
  return available[0];
}
