#!/usr/bin/env bun
import { Command } from "commander";
import { blocksAdd } from "./commands/blocks-add.ts";
import { blocksList } from "./commands/blocks-list.ts";
import { blocksTest } from "./commands/blocks-test.ts";
import { build } from "./commands/build.ts";
import { cacheLs } from "./commands/cache-ls.ts";
import { cacheVerify } from "./commands/cache-verify.ts";
import { preview } from "./commands/preview.ts";
import { plan } from "./commands/plan.ts";
import { configGet, configModels, configSetAgent } from "./commands/config.ts";
import { BspecError } from "./lib/errors.ts";

const program = new Command();

program
  .name("bspec")
  .description("bspec — a step-caching app harness");

const blocks = program.command("blocks").description("Manage blocks");

blocks
  .command("add <folder>")
  .description("Create a single executable block from every file under <folder>")
  .requiredOption("--summary <summary>", "One-line summary of the block")
  .option("--id <id>", "Block id (defaults to slugified folder name)")
  .option("--version <version>", "Block version (defaults to 0.1.0)")
  .action((folder, opts) =>
    blocksAdd(folder, { summary: opts.summary, id: opts.id, version: opts.version }),
  );

blocks
  .command("list")
  .description("List locally available blocks")
  .action(() => blocksList());

blocks
  .command("test <id>")
  .description("Run a block's own self-test")
  .action((id) => blocksTest(id));

program
  .command("plan")
  .description("Plan an app from <project>/SPEC.md by picking installed blocks (uses Pi)")
  .option("--project <dir>", "Project directory (defaults to cwd)")
  .option("--agent <selector>", "Model selector for this run (e.g. anthropic/claude-opus-4-5)")
  .option("--yes", "Skip the approval prompt and write the plan")
  .option("--answers <file>", "JSON array of { id, answer } to resolve clarifying questions")
  .action((opts) =>
    plan({
      project: opts.project,
      agent: opts.agent,
      yes: opts.yes,
      answers: opts.answers,
    }),
  );

program
  .command("build")
  .description("Build the app described by <project>/.bspec/plan.json into dist/")
  .option("--project <dir>", "Project directory (defaults to cwd)")
  .option("--agent <selector>", "Model selector for authoring gap blocks (e.g. anthropic/claude-opus-4-5)")
  .option("--yes", "Author any gap blocks without the approval prompt")
  .option("--no-author", "Build only the planned steps; never author blocks for gaps")
  .action((opts) =>
    build({
      project: opts.project,
      agent: opts.agent,
      yes: opts.yes,
      // commander sets `opts.author` to false when --no-author is passed.
      noAuthor: opts.author === false,
    }),
  );

const cache = program.command("cache").description("Inspect the output cache");

cache
  .command("ls")
  .description("List cached outputs")
  .action(() => cacheLs());

cache
  .command("verify")
  .description("Verify cache records still contain their archived outputs and metadata")
  .action(() => cacheVerify());

program
  .command("preview")
  .description("Show the path to dist/ and list produced files")
  .option("--project <dir>", "Project directory (defaults to cwd)")
  .option("--open", "Open the dist/ folder (macOS only)")
  .action((opts) => preview({ project: opts.project, open: opts.open }));

const config = program.command("config").description("Inspect and set bspec configuration");

config
  .command("get")
  .description("Show the resolved planner model and where it came from")
  .action(() => configGet());

config
  .command("set-agent <selector>")
  .description("Set the planner model (e.g. anthropic/claude-opus-4-5)")
  .action((selector) => configSetAgent(selector));

config
  .command("models [search]")
  .description("List Pi-available models you can pass to set-agent")
  .action((search) => configModels(search));

program
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    if (err instanceof BspecError) {
      process.stderr.write(err.message + "\n");
    } else {
      process.stderr.write(String((err as Error)?.stack ?? err) + "\n");
    }
    process.exit(1);
  });
