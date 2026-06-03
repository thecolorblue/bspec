import { ModelInfo } from "./model-info.js";

export function getAnthropicModels(): ModelInfo[] {
  return [
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      description: "Balanced coding model (default).",
      default: true,
    },
    {
      id: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      description: "Deepest reasoning; higher latency.",
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      description: "Fastest Claude model.",
    },
  ];
}
