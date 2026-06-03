export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  default?: boolean;
}

export function toChoice(model: ModelInfo): { value: string; name: string; description?: string } {
  return {
    value: model.id,
    name: model.default ? `${model.label} (default)` : model.label,
    description: model.description,
  };
}
