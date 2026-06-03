import { anthropicLogin } from "./anthropic-auth.js";
import { googleLogin } from "./google-auth.js";
import { openaiLogin } from "./openai-auth.js";
import { openrouterLogin, resolveOpenRouterKey } from "./openrouter-auth.js";
import { readConfig, writeConfig, getSecret } from "./keychain.js";
import { ProviderId } from "./types.js";

interface ProviderRecord extends Record<string, unknown> {
  logged_in_at?: string;
  model?: string;
}

interface SpecBuilderConfig extends Record<string, unknown> {
  provider?: ProviderId;
  providers?: Record<string, ProviderRecord>;
}

export interface ProviderRuntimeConfig {
  provider: ProviderId;
  piProvider: string;
  env: Record<string, string>;
}

export async function loginProvider(provider: ProviderId): Promise<void> {
  switch (provider) {
    case "anthropic":
      await anthropicLogin();
      break;
    case "openai":
      await openaiLogin();
      break;
    case "google":
      await googleLogin();
      break;
    case "openrouter":
      await openrouterLogin();
      break;
    default:
      throw new Error(`Unknown provider ${provider}`);
  }
  await recordProviderLogin(provider);
}

export async function recordProviderLogin(provider: ProviderId): Promise<void> {
  const config = (await readConfig()) as SpecBuilderConfig;
  const providers = config.providers ?? {};
  providers[provider] = {
    ...(providers[provider] ?? {}),
    logged_in_at: new Date().toISOString(),
  };
  config.providers = providers;
  config.provider = provider;
  await writeConfig(config);
}

export async function setActiveProvider(provider: ProviderId): Promise<void> {
  const config = (await readConfig()) as SpecBuilderConfig;
  config.provider = provider;
  if (!config.providers) {
    config.providers = {};
  }
  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
  await writeConfig(config);
}

export async function getActiveProvider(): Promise<ProviderId> {
  const config = (await readConfig()) as SpecBuilderConfig;
  if (config.provider && isProvider(config.provider)) {
    return config.provider;
  }
  return "anthropic";
}

export async function resolveProviderRuntime(provider: ProviderId): Promise<ProviderRuntimeConfig> {
  switch (provider) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      return {
        provider,
        piProvider: "anthropic",
        env: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {},
      };
    }
    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
        return {
          provider,
          piProvider: "openai",
          env: { OPENAI_API_KEY: apiKey },
        };
      }
      return {
        provider,
        piProvider: "openai-codex",
        env: {},
      };
    }
    case "google": {
      const apiKey =
        process.env.GEMINI_API_KEY ?? (await getSecret("google", { fallbackFile: "google" }));
      if (!apiKey) {
        throw new Error("No Google API key found — run `spec-builder login --provider google`.");
      }
      return {
        provider,
        piProvider: "google",
        env: { GEMINI_API_KEY: apiKey },
      };
    }
    case "openrouter": {
      const key = await resolveOpenRouterKey();
      if (!key) {
        throw new Error("No OpenRouter API key found — run `spec-builder login --provider openrouter`.");
      }
      return {
        provider,
        piProvider: "openrouter",
        env: { OPENROUTER_API_KEY: key },
      };
    }
    default:
      throw new Error(`Unsupported provider ${provider}`);
  }
}

export function isProvider(input: string): input is ProviderId {
  return input === "anthropic" || input === "openai" || input === "google" || input === "openrouter";
}
