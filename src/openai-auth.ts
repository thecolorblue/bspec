import chalk from "chalk";
import { resolvePiBinary } from "./pi-path.js";
import { runCommand } from "./utils/process.js";

export async function openaiLogin(): Promise<void> {
  const piBinary = resolvePiBinary();
  console.log(chalk.cyan("Opening OpenAI OAuth flow via pi..."));
  await runCommand(piBinary, ["auth", "login", "--provider", "openai-codex"]);
  console.log(chalk.green("OpenAI login complete."));
}
