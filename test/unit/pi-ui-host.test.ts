import { expect, test } from "bun:test";
import { createPlannerUiHost } from "../../src/lib/pi-ui-host.ts";

// The rpiv dialog reads these foreground colors and one background color; the
// host's hand-built palette must cover every key Theme.fg/bg can be asked for,
// since Theme throws on an unknown key. This guards the palette from drifting
// out of sync with the colors the extension actually renders.
const FG_COLORS_USED = [
  "text",
  "dim",
  "muted",
  "accent",
  "success",
  "error",
  "warning",
  "mdHeading",
  "mdCode",
] as const;

test("createPlannerUiHost builds a theme covering the colors rpiv renders", async () => {
  const host = await createPlannerUiHost();
  for (const color of FG_COLORS_USED) {
    const rendered = host.uiContext.theme.fg(color, "x");
    expect(rendered).toContain("x");
  }
  expect(host.uiContext.theme.bg("selectedBg", "y")).toContain("y");
  host.dispose();
});

test("notify writes without throwing and dispose is safe", async () => {
  const host = await createPlannerUiHost();
  expect(() => host.uiContext.notify("hello", "warning")).not.toThrow();
  expect(() => host.dispose()).not.toThrow();
});
