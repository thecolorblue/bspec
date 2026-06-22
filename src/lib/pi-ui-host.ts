import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  TUI,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
} from "@earendil-works/pi-tui";

/**
 * A minimal `ExtensionUIContext` good enough to host the rpiv
 * `ask_user_question` dialog from a headless Pi session.
 *
 * Pi only wires a real UI context inside its full `InteractiveMode`
 * (`createExtensionUIContext` is private). Since bspec runs planning headless,
 * we implement the one method the extension actually uses — `custom()` — backed
 * by a `pi-tui` TUI, mirroring `InteractiveMode.showExtensionCustom`. The TUI is
 * created per dialog and torn down immediately after, so normal planning output
 * keeps using ordinary stdout and the terminal is only commandeered while a
 * question is on screen. Everything else on the interface is a safe no-op.
 *
 * Create only when both stdin and stdout are TTYs; otherwise the extension
 * reports `no_ui` and bspec falls back to its headless `--answers` flow.
 */
export interface PlannerUiHost {
  uiContext: ExtensionUIContext;
  dispose: () => void;
}

export async function createPlannerUiHost(): Promise<PlannerUiHost> {
  // Imported lazily (not at module load) so this file never triggers Pi's
  // config init before `loadPi()` has set PI_PACKAGE_DIR. By the time this runs,
  // the planner has already called `loadPi()`, so the module is cached.
  const { Theme } = await import("@earendil-works/pi-coding-agent");
  const theme = buildTheme(Theme);

  // Publish our theme as Pi's active theme. The extension's `getMarkdownTheme()`
  // reads Pi's global theme proxy, and `initTheme()` would populate it by reading
  // builtin theme JSON from disk — files that aren't bundled into the
  // `bun build --compile` binary. Pi shares the active theme via these well-known
  // global symbols, so we set ours directly and skip the file read entirely.
  const slots = globalThis as Record<symbol, unknown>;
  slots[Symbol.for("@earendil-works/pi-coding-agent:theme")] = theme;
  slots[Symbol.for("@mariozechner/pi-coding-agent:theme")] = theme;
  // rpiv ignores the keybindings argument (`_kb`); a stub satisfies the type.
  const keybindings = {} as unknown as KeybindingsManager;

  const uiContext = {
    async custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (result: T) => void,
      ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: {
        overlay?: boolean;
        overlayOptions?: OverlayOptions | (() => OverlayOptions);
        onHandle?: (handle: OverlayHandle) => void;
      },
    ): Promise<T> {
      const tui = new TUI(new ProcessTerminal(), false);
      tui.start();
      let component: (Component & { dispose?(): void }) | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          let settled = false;
          const done = (result: T) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };
          Promise.resolve(factory(tui, theme, keybindings, done))
            .then((c) => {
              if (settled) return;
              component = c;
              if (options?.overlay) {
                const opts =
                  typeof options.overlayOptions === "function"
                    ? options.overlayOptions()
                    : options.overlayOptions;
                const handle = tui.showOverlay(component, opts);
                options.onHandle?.(handle);
              } else {
                tui.addChild(component);
                tui.setFocus(component);
              }
              tui.requestRender();
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              reject(err);
            });
        });
      } finally {
        try {
          component?.dispose?.();
        } catch {
          /* ignore dispose errors */
        }
        tui.stop();
      }
    },

    get theme() {
      return theme;
    },
    notify(message: string, type?: "info" | "warning" | "error") {
      process.stderr.write(`[${type ?? "info"}] ${message}\n`);
    },

    // Methods the rpiv dialog never reaches in bspec's planner flow. Provide
    // inert implementations so the ExtensionUIContext contract is satisfied.
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as unknown as ExtensionUIContext;

  return { uiContext, dispose: () => {} };
}

/**
 * A self-contained dark palette covering every `ThemeColor`/`ThemeBg` key Pi's
 * `Theme` knows about. `Theme.fg/bg` throw on an unknown key, so the maps must be
 * exhaustive. We build our own because the active theme singleton is not a public
 * export — only the `Theme` class is. Values are hex; truecolor preserves them.
 */
function buildTheme(Theme: typeof import("@earendil-works/pi-coding-agent").Theme): Theme {
  const fg: Record<string, string> = {
    accent: "#7aa2f7",
    border: "#3b4261",
    borderAccent: "#7aa2f7",
    borderMuted: "#2a2e42",
    success: "#9ece6a",
    error: "#f7768e",
    warning: "#e0af68",
    muted: "#565f89",
    dim: "#414868",
    text: "#c0caf5",
    thinkingText: "#9aa5ce",
    userMessageText: "#c0caf5",
    customMessageText: "#c0caf5",
    customMessageLabel: "#7aa2f7",
    toolTitle: "#7dcfff",
    toolOutput: "#a9b1d6",
    mdHeading: "#7aa2f7",
    mdLink: "#7dcfff",
    mdLinkUrl: "#565f89",
    mdCode: "#bb9af7",
    mdCodeBlock: "#c0caf5",
    mdCodeBlockBorder: "#3b4261",
    mdQuote: "#9aa5ce",
    mdQuoteBorder: "#565f89",
    mdHr: "#3b4261",
    mdListBullet: "#7aa2f7",
    toolDiffAdded: "#9ece6a",
    toolDiffRemoved: "#f7768e",
    toolDiffContext: "#565f89",
    syntaxComment: "#565f89",
    syntaxKeyword: "#bb9af7",
    syntaxFunction: "#7aa2f7",
    syntaxVariable: "#c0caf5",
    syntaxString: "#9ece6a",
    syntaxNumber: "#ff9e64",
    syntaxType: "#2ac3de",
    syntaxOperator: "#89ddff",
    syntaxPunctuation: "#a9b1d6",
    thinkingOff: "#565f89",
    thinkingMinimal: "#7aa2f7",
    thinkingLow: "#7dcfff",
    thinkingMedium: "#e0af68",
    thinkingHigh: "#ff9e64",
    thinkingXhigh: "#f7768e",
    bashMode: "#9ece6a",
  };
  const bg: Record<string, string> = {
    selectedBg: "#283457",
    userMessageBg: "#1f2335",
    customMessageBg: "#1f2335",
    toolPendingBg: "#2a2e42",
    toolSuccessBg: "#1f3a2b",
    toolErrorBg: "#3a1f2b",
  };
  return new Theme(fg as never, bg as never, "truecolor");
}
