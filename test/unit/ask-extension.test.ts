import { expect, test } from "bun:test";
import { loadAskUserQuestionTool } from "../../src/lib/ask-extension.ts";

test("captures the ask_user_question tool definition from the rpiv extension", async () => {
  const tool = await loadAskUserQuestionTool();
  expect(tool.name).toBe("ask_user_question");
  expect(typeof tool.execute).toBe("function");
  expect(tool.parameters).toBeDefined();
});

test("returns the same cached tool instance on repeated calls", async () => {
  const a = await loadAskUserQuestionTool();
  const b = await loadAskUserQuestionTool();
  expect(a).toBe(b);
});

test("captured tool reports no_ui when executed without a UI context", async () => {
  const tool = await loadAskUserQuestionTool();
  const params = {
    questions: [
      {
        question: "Pick one?",
        header: "Pick",
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
      },
    ],
  };
  // ctx.hasUI === false is the headless contract: the tool must decline cleanly.
  const result = await tool.execute(
    "call-1",
    params as never,
    undefined,
    undefined,
    { hasUI: false } as never,
  );
  expect(result.details).toMatchObject({ cancelled: true, error: "no_ui" });
});
