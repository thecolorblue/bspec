import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BspecError } from "./errors.ts";

let cached: ToolDefinition | undefined;

/**
 * Capture the `ask_user_question` tool from the rpiv extension as a plain
 * `ToolDefinition` we can hand to `createAgentSession({ customTools })`.
 *
 * We deliberately avoid Pi's filesystem extension loader: it loads `.ts` modules
 * via jiti from disk, which cannot see code bundled into the `bun build --compile`
 * single-file binary. The extension's default export is a factory
 * `(pi) => pi.registerTool(...)`; we invoke it with a stub `ExtensionAPI` whose
 * only real job is to record the registered tool. At call time the tool's
 * `execute(..., ctx)` receives a genuine `ExtensionContext` (with `ui`/`hasUI`)
 * from the session — see `planner-pi.ts`, which binds our UI host. The stub's
 * `events.emit` is a no-op the tool harmlessly calls for external listeners.
 */
export async function loadAskUserQuestionTool(): Promise<ToolDefinition> {
  if (cached) return cached;

  // Imported lazily so headless planning never pulls the extension's TUI/i18n
  // graph — only interactive (TTY) planning loads it. The extension's optional
  // i18n loader warns once per missing locale file (the locale JSONs aren't
  // bundled into the compiled binary); English is the only language bspec needs,
  // so we silence just those lines while it loads.
  const askUserQuestionExtension = await importExtensionQuietly();

  let captured: ToolDefinition | undefined;
  const stub = {
    registerTool: (tool: ToolDefinition) => {
      captured = tool;
    },
    registerCommand: () => {},
    events: { emit: () => {}, on: () => {}, off: () => {} },
    on: () => {},
  } as unknown as ExtensionAPI;

  await askUserQuestionExtension(stub);

  if (!captured) {
    throw new BspecError("rpiv-ask-user-question did not register its tool.");
  }
  cached = captured;
  return cached;
}

/** Import the extension, dropping its "falling back to English" locale warnings. */
async function importExtensionQuietly(): Promise<(pi: ExtensionAPI) => void> {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("rpiv-ask-user-question:")) {
      return;
    }
    originalWarn(...args);
  };
  try {
    const mod = await import("@juicesharp/rpiv-ask-user-question");
    return mod.default;
  } finally {
    console.warn = originalWarn;
  }
}
