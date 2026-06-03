import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import { ensureBaseDirs, sessionDir } from "./paths.js";
import { AgentStep, BuildSessionSummary, ProviderId } from "./types.js";

type UuidFn = () => string;

let uuidGeneratorPromise: Promise<UuidFn> | null = null;

async function loadUuidGenerator(): Promise<UuidFn> {
  if (!uuidGeneratorPromise) {
    uuidGeneratorPromise = import("@earendil-works/pi-agent-core")
      .then((mod: any) => {
        if (typeof mod.uuidv7 === "function") {
          return mod.uuidv7 as UuidFn;
        }
        if (typeof mod.default?.uuidv7 === "function") {
          return mod.default.uuidv7.bind(mod.default) as UuidFn;
        }
        return () => crypto.randomUUID();
      })
      .catch(() => () => crypto.randomUUID());
  }
  return uuidGeneratorPromise;
}

export interface SessionLogOptions {
  provider: ProviderId;
  model: string;
  specPath: string;
  outputDir: string;
}

export class SessionLog {
  readonly id: string;
  private summary: BuildSessionSummary;
  private stepsStream: fs.WriteStream;
  private stdoutStream: fs.WriteStream;
  private stderrStream: fs.WriteStream;
  private summaryPath: string;
  private nextSeq = 1;

  private constructor(
    id: string,
    summary: BuildSessionSummary,
    stepsStream: fs.WriteStream,
    stdoutStream: fs.WriteStream,
    stderrStream: fs.WriteStream,
    summaryPath: string,
  ) {
    this.id = id;
    this.summary = summary;
    this.stepsStream = stepsStream;
    this.stdoutStream = stdoutStream;
    this.stderrStream = stderrStream;
    this.summaryPath = summaryPath;
  }

  static async create(options: SessionLogOptions): Promise<SessionLog> {
    await ensureBaseDirs();
    const uuid = await generateSessionId();
    const dir = sessionDir(uuid);
    await fs.ensureDir(dir);

    const stepsPath = path.join(dir, "steps.ndjson");
    const stdoutPath = path.join(dir, "stdout.log");
    const stderrPath = path.join(dir, "stderr.log");
    const summaryPath = path.join(dir, "session.json");

    const summary: BuildSessionSummary = {
      id: uuid,
      provider: options.provider,
      model: options.model,
      specPath: options.specPath,
      outputDir: options.outputDir,
      status: "queued",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const log = new SessionLog(
      uuid,
      summary,
      fs.createWriteStream(stepsPath, { flags: "a" }),
      fs.createWriteStream(stdoutPath, { flags: "a" }),
      fs.createWriteStream(stderrPath, { flags: "a" }),
      summaryPath,
    );

    await fs.writeJson(summaryPath, summary, { spaces: 2 });
    return log;
  }

  get directory(): string {
    return sessionDir(this.id);
  }

  async writeResolvedSpec(markdown: string): Promise<string> {
    const resolvedPath = path.join(this.directory, "resolved-spec.md");
    await fs.writeFile(resolvedPath, markdown, "utf8");
    return resolvedPath;
  }

  appendStdout(chunk: string | Buffer): void {
    this.stdoutStream.write(chunk);
  }

  appendStderr(chunk: string | Buffer): void {
    this.stderrStream.write(chunk);
  }

  async appendAgentEvent(
    input: Omit<AgentStep, "seq" | "ts" | "tokens_in" | "tokens_out" | "duration_ms"> & {
      ts?: string;
      tokens_in?: number | null;
      tokens_out?: number | null;
      duration_ms?: number | null;
    },
  ): Promise<AgentStep> {
    const step: AgentStep = {
      seq: this.nextSeq++,
      ts: input.ts ?? new Date().toISOString(),
      kind: input.kind,
      payload: input.payload,
      tokens_in: input.tokens_in ?? null,
      tokens_out: input.tokens_out ?? null,
      duration_ms: input.duration_ms ?? null,
    };
    this.stepsStream.write(JSON.stringify(step) + "\n");
    return step;
  }

  async updateSummary(patch: Partial<BuildSessionSummary>): Promise<void> {
    this.summary = {
      ...this.summary,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeJson(this.summaryPath, this.summary, { spaces: 2 });
  }

  async close(): Promise<void> {
    await Promise.all([
      new Promise<void>((resolve) => this.stepsStream.end(resolve)),
      new Promise<void>((resolve) => this.stdoutStream.end(resolve)),
      new Promise<void>((resolve) => this.stderrStream.end(resolve)),
    ]);
  }
}

async function generateSessionId(): Promise<string> {
  const generator = await loadUuidGenerator();
  return generator();
}
