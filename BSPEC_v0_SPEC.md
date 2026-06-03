# SPEC.md — bspec v0: Block Creation and Cache Reuse Proof

## Overview

Build `bspec` v0 as a TypeScript command-line application that proves the core harness loop works without AI planning:

1. Snapshot a working folder of files into one self-describing executable block.
2. Reference that block from a handwritten `.bspec/plan.json` in a separate app folder.
3. Build the app into `dist/` by running the block once.
4. Build the same app again and confirm the step is replayed from cache instead of run.

The purpose of v0 is not to create full apps from natural language yet. The purpose is to prove the block contract, block authoring, cache key calculation, output restoration, and provenance records end to end.

## Users

### Primary user

A technical builder validating the architecture of `bspec` before adding AI planning.

### Secondary future user

A non-technical app creator who will eventually benefit from this deterministic block system, but who is not the target user for v0.

## Product Principles

- Deterministic builds only.
- No AI calls in v0.
- Every generated output file must come from a block.
- A block must be inspectable, executable, and independently testable.
- Cache replay must be obvious in the CLI output.
- Tests should prove behavior through real filesystem operations, not mocks only.

## Chosen Implementation Stack

Use Node.js with TypeScript for v0.

The CLI source code should be written in TypeScript and built to JavaScript for normal execution. During development, the project may use `tsx` or an equivalent TypeScript runner, but the distributed CLI should not require users to understand TypeScript tooling.

Suggested libraries:

- CLI argument parsing: `commander` or `cac`
- Schema validation: `zod`
- Tests: `vitest`
- Child process execution: Node `child_process` or `execa`
- Filesystem: Node `fs/promises`
- Hashing: Node `crypto`
- Temporary directories: Node `os.tmpdir()` plus `fs.mkdtemp`
- Tar/gzip handling: a maintained npm tar package, or a small internal archive abstraction

The generated folder snapshot block may be a Node-compatible `.block.mjs` file with a shebang and an embedded base64 tarball. The `bspec` app itself must be TypeScript, but generated blocks do not need to be authored by hand in TypeScript for v0.

## Required CLI Commands

### `bspec blocks add <folder> --summary <summary> [--id <id>] [--version <version>]`

Create a single executable block file from every file under `<folder>`.

Behavior:

- Read all files under `<folder>` recursively.
- Ignore common junk by default: `.git`, `node_modules`, `.DS_Store`, `dist`, `.bspec`.
- Preserve relative file paths.
- Sort file paths before manifest generation and archive creation.
- Default `id` to a slugified version of the source folder name.
- Default `version` to `0.1.0`.
- Store the block at `${BSPEC_HOME}/blocks/<id>.block.mjs`.
- The block must implement:
  - `--manifest`
  - `--apply <out_dir> <params.json>`
  - `--test`
- The manifest for a folder snapshot block must include:
  - `id`
  - `version`
  - `summary`
  - `params: {}`
  - `produces`, sorted by relative path
  - `needs: []`
- `--apply` must copy the embedded files into `<out_dir>`.
- `--test` must apply the embedded files into a temporary directory and verify that every expected produced file exists with the expected content hash.

Example:

```bash
bspec blocks add ./fixtures/hello-extension \
  --id hello-extension \
  --version 0.1.0 \
  --summary "A minimal hello extension fixture"
```

Expected output:

```text
Created block hello-extension@0.1.0
Saved to ~/.bspec/blocks/hello-extension.block.mjs
3 files captured
Run: bspec blocks test hello-extension
```

### `bspec blocks list`

List locally available blocks.

Expected output shape:

```text
ID                VERSION  SUMMARY
hello-extension   0.1.0    A minimal hello extension fixture
```

### `bspec blocks test <id>`

Run the block's own `--test` command.

Behavior:

- Find the block by id in `${BSPEC_HOME}/blocks`.
- Execute the block with `--test`.
- Show pass/fail in plain language.
- Exit nonzero if the block test fails.

Expected output:

```text
Testing hello-extension@0.1.0... ok
```

### `bspec build [--project <dir>]`

Build the app described by `<project>/.bspec/plan.json` into `<project>/dist`.

Behavior:

- Default `<project>` to the current working directory.
- Read `<project>/.bspec/plan.json`.
- Support a linear list of steps in v0.
- For each step:
  - Load the block manifest.
  - Normalize params as stable JSON.
  - Compute the cache key.
  - If cache exists, replay cached outputs into `dist/` and print `[replayed]`.
  - If cache does not exist, run the block with `--apply`, capture outputs, save them to cache, and print `[ran]`.
- Write `<project>/.bspec/build.json` with provenance for each output file.
- Write per-block logs under `<project>/.bspec/logs/`.
- Exit nonzero if any step fails.

V0 cache key:

```text
sha256(block_id + version + normalized_params + sorted(hashes_of_needed_outputs))
```

For v0, `needs` may be parsed but only empty `needs: []` must be supported.

Expected first build output:

```text
Building hello extension... hello-extension@0.1.0 [ran]      -> <cache-key>
Done. 1 block built (0 replayed, 1 ran).
```

Expected second build output:

```text
Building hello extension... hello-extension@0.1.0 [replayed] -> <cache-key>
Done. 1 block built (1 replayed, 0 ran).
```

### `bspec cache ls`

List cached outputs.

Expected output shape:

```text
KEY        BLOCK             VERSION  STATUS
abc123     hello-extension   0.1.0    fresh
```

### `bspec cache verify`

Verify cache records still contain their archived outputs and metadata.

Behavior:

- Check every `${BSPEC_HOME}/cache/<key>` directory.
- Confirm each record has output archive data and metadata.
- Confirm metadata references a block id, version, params hash, and produced file list.
- Exit nonzero if any cache entry is corrupt.

### `bspec preview [--project <dir>]`

For v0, preview does not need to launch a real browser or app runtime.

Behavior:

- Print the path to `dist/`.
- List the files produced by the last build.
- Optionally open the folder on macOS if `--open` is passed.

Expected output:

```text
Preview available at ./dist
Files:
- manifest.json
- popup.html
- popup.js
```

## Project Layout

The app should support this layout:

```text
~/.bspec/
  blocks/
    hello-extension.block.mjs
  cache/
    <cache-key>/
      outputs.tar.gz
      meta.json

my-test-app/
  .bspec/
    plan.json
    build.json
    logs/
      hello-extension.log
  dist/
```

For tests, do not use the real user home directory. All tests must support `BSPEC_HOME=<temp_dir>/.bspec-home`.

## Plan File Format

V0 uses a handwritten plan file.

Example `<project>/.bspec/plan.json`:

```json
{
  "spec_hash": "manual-v0",
  "steps": [
    {
      "id": "hello-extension",
      "version": "0.1.0",
      "summary": "Building hello extension",
      "params": {},
      "needs": []
    }
  ]
}
```

Validation rules:

- `steps` must be a non-empty array.
- `id` is required.
- `version` is required.
- `params` defaults to `{}` if omitted.
- `needs` defaults to `[]` if omitted.
- V0 may reject non-empty `needs` with a clear message: `Dependency graph builds are not supported in v0.`

## Block Manifest Format

Example manifest printed by a generated block:

```json
{
  "id": "hello-extension",
  "version": "0.1.0",
  "summary": "A minimal hello extension fixture",
  "params": {},
  "produces": [
    "manifest.json",
    "popup.html",
    "popup.js"
  ],
  "needs": []
}
```

## Build Provenance Format

After build, write `<project>/.bspec/build.json`:

```json
{
  "built_at": "2026-06-03T00:00:00.000Z",
  "outputs": {
    "manifest.json": {
      "by": "hello-extension@0.1.0",
      "cache": "<cache-key>",
      "hash": "<sha256>"
    },
    "popup.html": {
      "by": "hello-extension@0.1.0",
      "cache": "<cache-key>",
      "hash": "<sha256>"
    },
    "popup.js": {
      "by": "hello-extension@0.1.0",
      "cache": "<cache-key>",
      "hash": "<sha256>"
    }
  }
}
```

## Test Fixture App

Create a fixture folder such as `test/fixtures/hello-extension-source`:

```text
hello-extension-source/
  manifest.json
  popup.html
  popup.js
```

Example file contents:

`manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Hello Extension",
  "version": "0.1.0",
  "action": {
    "default_popup": "popup.html"
  }
}
```

`popup.html`:

```html
<!doctype html>
<html>
  <body>
    <h1>Hello from bspec</h1>
    <script src="popup.js"></script>
  </body>
</html>
```

`popup.js`:

```js
document.body.dataset.loaded = "true";
```

## Required Automated Tests

### Unit tests

1. Stable JSON normalization returns the same string for objects with reordered keys.
2. Cache key generation is stable for the same block id, version, params, and needs hashes.
3. Cache key changes when the block version changes.
4. File walker returns sorted relative paths.
5. File walker ignores `.git`, `node_modules`, `.DS_Store`, `dist`, and `.bspec`.
6. Generated manifest contains the expected id, version, summary, params, produces, and needs.
7. Build provenance records output file hashes.

### Integration tests

1. `blocks add` creates a single executable block file in the configured `BSPEC_HOME`.
2. Running the generated block with `--manifest` prints valid JSON.
3. `blocks test <id>` passes for the generated block.
4. A handwritten plan with one step builds the fixture into a separate app's `dist/` folder.
5. The first build prints `[ran]` and creates a cache entry.
6. The second build prints `[replayed]` and uses the same cache key.
7. Deleting `dist/` and running build again restores files from cache and prints `[replayed]`.
8. `build.json` maps every output file to `hello-extension@0.1.0` and the cache key.
9. `cache ls` shows the saved cache entry.
10. `cache verify` passes after the first successful build.

## Manual Demo Script

The following demo must work from a clean checkout:

```bash
export BSPEC_HOME="$(pwd)/.tmp/bspec-home"
rm -rf .tmp demo-app

bspec blocks add ./test/fixtures/hello-extension-source \
  --id hello-extension \
  --version 0.1.0 \
  --summary "A minimal hello extension fixture"

bspec blocks test hello-extension

mkdir -p demo-app/.bspec
cat > demo-app/.bspec/plan.json <<'JSON'
{
  "spec_hash": "manual-v0",
  "steps": [
    {
      "id": "hello-extension",
      "version": "0.1.0",
      "summary": "Building hello extension",
      "params": {},
      "needs": []
    }
  ]
}
JSON

bspec build --project demo-app
bspec build --project demo-app
bspec cache ls
bspec preview --project demo-app
```

The first build must show `[ran]`.
The second build must show `[replayed]`.
The files in `demo-app/dist` must byte-for-byte match the original fixture source files.

## Error Handling

Errors should be plain and actionable.

Examples:

- Missing plan file: `No plan found at <project>/.bspec/plan.json. Create one before running bspec build.`
- Unknown block: `Block hello-extension@0.1.0 was not found in <BSPEC_HOME>/blocks.`
- Unsupported dependency graph: `Dependency graph builds are not supported in v0. Step <id> has non-empty needs.`
- Corrupt cache: `Cache entry <key> is missing outputs.tar.gz. Run bspec cache prune or rebuild with a new version.`
- Block test failure: `Block hello-extension@0.1.0 failed its self-test. See <project>/.bspec/logs/hello-extension.log.`

## Out of Scope for v0

- AI planner from `SPEC.md` to `plan.json`
- `bspec init` interview
- `bspec change`
- `bspec fix`
- Dependency graph execution
- Parallel builds
- Remote registries
- Publishing or pulling shared blocks
- User accounts
- App deployment
- Template params beyond `{}`
- Drift detection for hand-edited output files
- Multiple block runtimes
- Sandboxing arbitrary third-party blocks beyond normal process execution

## Definition of Done

v0 is done when a developer can run the manual demo script and see this loop work:

1. A folder is converted into a block.
2. The block passes its own self-test.
3. A separate app builds from a handwritten plan.
4. First build runs the block and saves outputs to cache.
5. Second build replays the cached outputs without running the block.
6. Provenance shows which block produced every output file.
7. Automated tests cover the same flow in temporary directories.
