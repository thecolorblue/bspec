import { ModelInfo } from "./model-info.js";

export function getGoogleModels(): ModelInfo[] {
  return [
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      description: "Best reasoning quality.",
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      description: "Balanced speed and quality (default).",
      default: true,
    },
    {
      id: "gemini-2.5-flash-lite",
      label: "Gemini 2.5 Flash Lite",
      description: "Fastest / lowest cost.",
    },
  ];
}
