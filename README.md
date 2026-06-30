`bspec` is a CLI agent harness, built with Pi and bun, that takes a SPEC.md file and builds a complete functional application.

There are three steps to creating a full application from a SPEC.md file: plan, build, and fix.

## Plan

The plan step creates a `plan.json` file with the whole application split into reuseable blocks. It will try to reuse blocks it has already created. You can also create your own blocks to save time and tokens. 

## Build

The build step is a deterministic creation of the repository from the pre-built blocks selected in the planning step. It runs through the `plan.json` file created earlier.

## Fix

The fix step is a loop that continues asking the LLM to complete the app until the tests have passed and the build is clean. 

-------

Getting Started:

```
npm install

# for testing
npm run bspec plan

# for use in other folders
npm run build:bin
export PATH="$(pwd)/dist:$PATH"
```

----

## Blocks

Blocks are a combination of code and parameters wrapped into a `.ts` file. They are deterministic, meaning they will create the same code given the same parameters. They act as a cache for previous code already built, and are designed to be more re-usable than wrapping code into a package or library. Boilerplate projects and configuration fit nicely into blocks, that cna then be re-used across applications and across builds. 

## Commands

blocks             Manage blocks
plan [options]     Plan an app from <project>/SPEC.md by picking installed blocks (uses Pi)
build [options]    Build the app described by <project>/.bspec/plan.json into dist/
fix [options]      Drive a project's build and test commands to green by letting Pi edit files (uses Pi)
cache              Inspect the output cache
preview [options]  Show the path to dist/ and list produced files
config             Inspect and set bspec configuration
help [command]     display help for command