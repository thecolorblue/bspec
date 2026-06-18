import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath, loadConfig, resolveBspecHome } from "../config.ts";
import { agentSourceLabel, parseSelector, resolveAgentSelector } from "../lib/agent.ts";
import { loadPi } from "../lib/pi.ts";

/** `bspec config get` — show the resolved planner model and where it came from. */
export async function configGet(
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveBspecHome(env);
  const resolved = await resolveAgentSelector({ env, home });

  if (resolved.selector) {
    process.stdout.write(`agent: ${resolved.selector} (${agentSourceLabel(resolved.source)})\n`);
  } else {
    process.stdout.write("agent: (unset — Pi will choose a default model) (default)\n");
  }
}

/** `bspec config set-agent <selector>` — persist the planner model selector. */
export async function configSetAgent(
  selector: string,
  opts: { home?: string } = {},
): Promise<void> {
  const home = opts.home ?? resolveBspecHome();
  parseSelector(selector); // validate; throws BspecError on a malformed selector

  const file = configPath(home);
  const current = await loadConfig(home);
  const next = { ...current, agent: selector.trim() };

  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2) + "\n");

  process.stdout.write(`Set planner model to ${selector.trim()}\n`);
  process.stdout.write(`Saved to ${file}\n`);
}

/**
 * `bspec config models [search]` — the model picker. Lists models Pi reports as
 * available (those with valid auth) so the user can copy a selector into
 * `set-agent`. Prints only non-secret metadata (provider/id + display name).
 */
export async function configModels(
  search?: string,
  opts: { loadModels?: () => Promise<Array<{ provider: string; id: string; name?: string }>> } = {},
): Promise<void> {
  const models = await (opts.loadModels ?? defaultLoadModels)();

  const needle = search?.trim().toLowerCase();
  const filtered = needle
    ? models.filter((m) =>
        `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(needle),
      )
    : models;

  if (filtered.length === 0) {
    if (models.length === 0) {
      process.stdout.write(
        "No models available. Authenticate a provider with Pi (`pi` then /login) " +
          "or set a provider API key in your environment.\n",
      );
    } else {
      process.stdout.write(`No available models match "${search}".\n`);
    }
    return;
  }

  process.stdout.write("Available models (selectors you can pass to set-agent):\n");
  for (const model of [...filtered].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  )) {
    const selector = `${model.provider}/${model.id}`;
    const name = model.name && model.name !== model.id ? `  (${model.name})` : "";
    process.stdout.write(`  ${selector}${name}\n`);
  }
}

/** Read available models straight from Pi's registry. Never touches secrets. */
async function defaultLoadModels(): Promise<
  Array<{ provider: string; id: string; name?: string }>
> {
  const pi = await loadPi();
  const authStorage = pi.AuthStorage.create();
  const registry = pi.ModelRegistry.create(authStorage);
  return registry
    .getAvailable()
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
}
