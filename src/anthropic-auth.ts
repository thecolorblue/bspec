import chalk from "chalk";
import { resolvePiBinary } from "./pi-path.js";
import { runCommand } from "./utils/process.js";

export async function anthropicLogin(): Promise<void> {
  const piBinary = resolvePiBinary();
  console.log(chalk.cyan("Opening Anthropic OAuth flow via pi..."));
  await runCommand(piBinary, ["auth", "login", "--provider", "anthropic"]);
  console.log(chalk.green("Anthropic login complete."));
}
