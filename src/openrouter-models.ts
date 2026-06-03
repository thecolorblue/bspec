import { ModelInfo } from "./model-info.js";

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  supported_parameters?: string[];
  pricing?: Record<string, unknown>;
}

interface OpenRouterResponse {
  data?: OpenRouterModel[];
}

export async function fetchOpenRouterModels(apiKey: string): Promise<ModelInfo[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch OpenRouter models: ${response.status} ${body}`);
  }

  const payload = (await response.json()) as OpenRouterResponse;
  const models = (payload.data ?? []).filter((model) => {
    if (!model) {
      return false;
    }
    const params = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    return params.some((param) => param === "tools" || param === "tool_choice");
  });

  return models
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
    .map((model) => ({
      id: model.id,
      label: model.name ?? model.id,
      description: model.description,
    }));
}
