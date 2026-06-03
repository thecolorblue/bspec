import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { setSecret } from "./keychain.js";
import { ensureBaseDirs } from "./paths.js";

const ACCOUNT = "google";

export async function googleLogin(): Promise<void> {
  await ensureBaseDirs();
  const apiKey = (await input({
    message: "Enter your Google Gemini API key",
  })).trim();

  if (!apiKey) {
    throw new Error("Google API key cannot be empty.");
  }

  const result = await setSecret(ACCOUNT, apiKey, { fallbackFile: "google" });
  if (result.usedFallback) {
    console.warn(
      chalk.yellow(
        "Keychain unavailable; saved API key to ~/.spec-builder/google-credentials.json (mode 0600).",
      ),
    );
  } else {
    console.log(chalk.green("Stored API key in system keychain."));
  }
  console.log(chalk.green("Google API key saved."));
}
