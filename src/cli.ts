#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { select } from "@inquirer/prompts";
import { loginProvider, getActiveProvider, isProvider, resolveProviderRuntime } from "./auth.js";
import { parseSpecFile, SpecParseError } from "./spec-parser.js";
import { runQuestions } from "./question-runner.js";
import { resolveSpec } from "./resolved-spec.js";
import { orchestrateBuild } from "./orchestrator.js";
import { sessionDir } from "./paths.js";
import { fetchOpenRouterModels } from "./openrouter-models.js";
import { getAnthropicModels } from "./anthropic-models.js";
import { getOpenAIModels } from "./openai-models.js";
import { getGoogleModels } from "./google-models.js";
import { ModelInfo, toChoice } from "./model-info.js";
import { ProviderId } from "./types.js";

interface BuildOptions {
  provider?: string;
  model?: string;
  skipRepair?: boolean;
  autoApprove?: boolean;
}

const program = new Command();
program.name("spec-builder").description("Spec-driven builder orchestrating pi coding agent sessions.");

program
  .command("login")
  .description("Authenticate with a provider.")
  .option("--provider <provider>", "anthropic|openai|google|openrouter", "anthropic")
  .action(async (cmdOptions: { provider: string }) => {
    const providerId = cmdOptions.provider;
    if (!isProvider(providerId)) {
      console.error(chalk.red(`Unknown provider "${providerId}".`));
      process.exitCode = 1;
      return;
    }
    try {
      await loginProvider(providerId);
      console.log(chalk.green(`Logged in with provider ${providerId}.`));
    } catch (error) {
      console.error(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

program
  .argument("<spec>", "Path to SPEC.md")
  .option("--provider <provider>", "Override provider for this run")
  .option("--model <model>", "Override model id")
  .option("--skip-repair", "Skip the repair loop", false)
  .option("--auto-approve", "Auto-approve PLAN.md without prompting", false)
  .action(async (specArg: string, cliOptions: BuildOptions) => {
    try {
      await runBuild(specArg, cliOptions);
    } catch (error) {
      if (error instanceof SpecParseError) {
        console.error(chalk.red(`Failed to parse spec: ${error.message}`));
      } else {
        console.error(chalk.red((error as Error).message));
      }
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

async function runBuild(specPath: string, options: BuildOptions): Promise<void> {
  const absoluteSpecPath = path.resolve(specPath);
  const spec = await parseSpecFile(absoluteSpecPath);

  const answers = await runQuestions(spec);
  const resolvedSpec = await resolveSpec(spec, answers);

  const providerId = await resolveProvider(options.provider);
  const providerRuntime = await resolveProviderRuntime(providerId);

  const modelId = await resolveModel(providerId, providerRuntime, options.model);

  const result = await orchestrateBuild({
    spec,
    resolvedSpec,
    providerConfig: providerRuntime,
    model: modelId,
    skipRepair: Boolean(options.skipRepair),
    autoApprove: Boolean(options.autoApprove),
  });

  const logPath = sessionDir(result.sessionId);
  if (result.status === "completed") {
    console.log(chalk.green(`Build completed. Session log at ${logPath}`));
  } else if (result.status === "cancelled") {
    console.log(chalk.yellow(`Build cancelled. Session log at ${logPath}`));
  } else {
    console.error(chalk.red(`Build failed. Session log at ${logPath}`));
  }
}

async function resolveProvider(override?: string): Promise<ProviderId> {
  if (override) {
    if (!isProvider(override)) {
      throw new Error(`Unknown provider "${override}".`);
    }
    return override as ProviderId;
  }
  return getActiveProvider();
}

async function resolveModel(
  provider: ProviderId,
  runtime: Awaited<ReturnType<typeof resolveProviderRuntime>>,
  override?: string,
): Promise<string> {
  if (override) {
    return override;
  }

  let models: ModelInfo[] = [];
  switch (provider) {
    case "anthropic":
      models = getAnthropicModels();
      break;
    case "openai":
      models = getOpenAIModels();
      break;
    case "google":
      models = getGoogleModels();
      break;
    case "openrouter": {
      const key = runtime.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
      if (!key) {
        throw new Error("OpenRouter API key unavailable.");
      }
      models = await fetchOpenRouterModels(key);
      break;
    }
    default:
      throw new Error(`Unsupported provider ${provider}`);
  }

  if (models.length === 0) {
    throw new Error(`No models available for provider ${provider}.`);
  }

  if (models.length === 1) {
    const model = models[0]!;
    console.log(chalk.gray(`Using model ${model.id}`));
    return model.id;
  }

  const defaultModel = models.find((model) => model.default)?.id;
  const choice = await select({
    message: "Select model",
    choices: models.map(toChoice),
    default: defaultModel,
  });
  return choice;
}
