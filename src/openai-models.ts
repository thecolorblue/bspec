import { ModelInfo } from "./model-info.js";

export function getOpenAIModels(): ModelInfo[] {
  return [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      description: "High reasoning depth.",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      description: "Faster, lower cost.",
      default: true,
    },
    {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      description: "Tool-optimized coding model.",
    },
  ];
}
