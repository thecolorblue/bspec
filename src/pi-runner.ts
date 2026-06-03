import { spawn } from "node:child_process";
import { resolvePiBinary } from "./pi-path.js";
import { SessionLog } from "./session-log.js";
import { AgentStepKind } from "./types.js";
import { ProviderRuntimeConfig } from "./auth.js";

export interface PiRunOptions {
  session: SessionLog;
  provider: ProviderRuntimeConfig;
  model: string;
  sessionId: string;
  resolvedSpecPath: string;
  systemPrompt?: string;
  instruction: string;
  cwd: string;
  onEvent?: (event: { kind: AgentStepKind; raw: Record<string, unknown> }) => void;
}

export interface PiRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  const piBinary = resolvePiBinary();
  const args = ["-p", "--mode", "json", "--provider", options.provider.piProvider, "--model", options.model, "--session-id", options.sessionId];
  if (options.systemPrompt) {
    args.push("--append-system-prompt", options.systemPrompt);
  }
  args.push(`@${options.resolvedSpecPath}`);
  args.push(options.instruction);

  const env = {
    ...process.env,
    ...options.provider.env,
  };

  const child = spawn(piBinary, args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const kind = classifyEventKind(parsed);
      void options.session.appendAgentEvent({
        kind,
        payload: parsed,
        tokens_in:
          extractNumber(parsed, ["metrics", "input_tokens"]) ??
          extractNumber(parsed, ["tokens", "input"]),
        tokens_out:
          extractNumber(parsed, ["metrics", "output_tokens"]) ??
          extractNumber(parsed, ["tokens", "output"]),
        duration_ms: extractNumber(parsed, ["metrics", "duration_ms"]),
      });
      options.onEvent?.({ kind, raw: parsed });
    } catch {
      // ignore parse errors; ndjson may be fragmented
    }
  };

  child.stdout.on("data", (chunk: string) => {
    options.session.appendStdout(chunk);
    stdoutBuffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      flushLine(line);
    }
  });

  child.stdout.on("end", () => {
    if (stdoutBuffer.trim()) {
      flushLine(stdoutBuffer);
    }
  });

  child.stderr.on("data", (chunk: string) => {
    options.session.appendStderr(chunk);
  });

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", async (code, signal) => {
      resolve({ exitCode: code, signal });
    });
  });
}

function extractNumber(obj: Record<string, unknown>, path: string[]): number | null {
  let current: unknown = obj;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "number") {
    return current;
  }
  return null;
}

function classifyEventKind(event: Record<string, unknown>): AgentStepKind {
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (!type) {
    return "status";
  }
  if (type.includes("error")) {
    return "error";
  }
  if (type.includes("toolcall") || type === "tool_call" || type === "tool_execution_start") {
    return "tool_call";
  }
  if (type.includes("tool_execution_end") || type.includes("tool_result")) {
    return "tool_result";
  }
  if (type.includes("text") || type.includes("thinking") || type.includes("message_update")) {
    return "model_response";
  }
  if (type.includes("turn_start") || type.includes("agent_start") || type.includes("message_start")) {
    return "model_request";
  }
  if (type.includes("turn_end") || type.includes("agent_end") || type.includes("message_end")) {
    return "model_response";
  }
  return "status";
}
