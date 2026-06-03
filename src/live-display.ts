import { createLogUpdate } from "log-update";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { AgentStepKind } from "./types.js";

type Phase = "processing" | "generating" | "tool_running" | "idle" | "error";

interface ExecuteDisplayOptions {
  totalSteps: number;
  useUnicode: boolean;
  stream: NodeJS.WriteStream;
}

const TAIL_LINES = 5;
const MIN_BAR_WIDTH = 10;
const MAX_BAR_WIDTH = 40;

export interface PiEventPayload {
  kind: AgentStepKind;
  raw: Record<string, unknown>;
}

export class ExecuteDisplay {
  private readonly totalSteps: number;
  private readonly useUnicode: boolean;
  private readonly log: ReturnType<typeof createLogUpdate>;
  private readonly stream: NodeJS.WriteStream;
  private completedSteps = 0;
  private currentStep: number | null = null;
  private currentSummary = "";
  private currentPhase: Phase = "processing";
  private tailStreams = new Map<string, string>();
  private activeStream: string | null = null;
  private tailLines: string[] = Array(TAIL_LINES).fill("");
  private lastErrorMessage: string | null = null;
  private finalised = false;
  private finalGlyph: string | null = null;

  constructor(options: ExecuteDisplayOptions) {
    this.totalSteps = options.totalSteps;
    this.useUnicode = options.useUnicode;
    this.stream = options.stream;
    this.log = createLogUpdate(this.stream);
  }

  startStep(stepNumber: number, summary: string): void {
    this.currentStep = stepNumber;
    this.currentSummary = summary;
    this.currentPhase = "processing";
    this.activeStream = null;
    this.tailStreams.clear();
    this.tailLines = Array(TAIL_LINES).fill("");
    this.lastErrorMessage = null;
    this.render();
  }

  handlePiEvent(event: PiEventPayload): void {
    if (this.finalised) {
      return;
    }
    const type = typeof event.raw.type === "string" ? event.raw.type.toLowerCase() : "";

    if (event.kind === "error" || type.includes("error")) {
      this.currentPhase = "error";
      const message = extractErrorMessage(event.raw);
      if (message) {
        this.lastErrorMessage = message;
        this.log.clear();
        console.error(message);
      }
      this.render();
      return;
    }

    const nextPhase = nextPhaseForType(this.currentPhase, type);
    let phaseChanged = false;
    if (nextPhase && nextPhase !== this.currentPhase) {
      this.currentPhase = nextPhase;
      phaseChanged = true;
    }
    if (shouldUpdateTail(type)) {
      const stream = inferStreamName(type);
      const mode = type.endsWith("delta") ? "append" : "replace";
      const content = extractContent(event.raw);
      if (content) {
        this.updateTail(stream, content, mode);
      }
    } else if (phaseChanged) {
      this.render();
    }
  }

  completeStep(): void {
    if (this.currentStep !== null) {
      this.completedSteps = Math.max(this.completedSteps, this.currentStep);
      this.currentSummary = `Step ${this.currentStep} complete`;
      this.currentPhase = "idle";
      this.currentStep = null;
      this.tailLines = Array(TAIL_LINES).fill("");
      this.render();
    }
  }

  failStep(reason: string): void {
    if (this.currentStep !== null) {
      this.currentSummary = reason;
      this.currentPhase = "error";
      this.render();
    }
  }

  finalize(status: "completed" | "failed" | "cancelled", reason?: string): void {
    this.finalised = true;
    this.completedSteps = this.totalSteps;
    const summary = statusSummary(status, reason, this.useUnicode);
    this.currentSummary = summary.text;
    this.tailLines = Array(TAIL_LINES).fill("");
    this.currentPhase = summary.phase;
    this.finalGlyph = summary.glyph ?? null;
    this.render(true);
    this.log.done();
  }

  private updateTail(stream: string, content: string, mode: "append" | "replace"): void {
    const sanitized = stripAnsi(content);
    const existing = this.tailStreams.get(stream) ?? "";
    const next = mode === "append" ? existing + sanitized : sanitized;
    this.tailStreams.set(stream, next);
    this.activeStream = stream;
    this.tailLines = computeTailLines(next, this.stream.columns ?? 80);
    this.render();
  }

  private render(force = false): void {
    if (this.finalised && !force) {
      return;
    }
    const width = Math.max(this.stream.columns ?? 80, 40);
    const lines: string[] = [];
    lines.push(this.renderProgressLine(width));
    lines.push(this.renderSummaryLine(width));
    lines.push(...this.renderTailLines(width));
    this.log(lines.join("\n"));
  }

  private renderProgressLine(width: number): string {
    const completed = Math.min(this.completedSteps, this.totalSteps);
    const base = this.currentStep ? this.currentStep - 1 : completed;
    const ratio = this.totalSteps === 0 ? 1 : Math.min(base / this.totalSteps, 1);
    const barWidth = Math.min(Math.max(Math.floor(width * 0.4), MIN_BAR_WIDTH), MAX_BAR_WIDTH);
    const filled = Math.round(ratio * barWidth);
    const empty = Math.max(barWidth - filled, 0);
    const fillChar = this.useUnicode ? "█" : "#";
    const emptyChar = this.useUnicode ? "░" : "-";
    const bar = `${fillChar.repeat(filled)}${emptyChar.repeat(empty)}`;
    const stepLabel = this.currentStep
      ? `Step ${this.currentStep}/${this.totalSteps}`
      : `Step ${completed}/${this.totalSteps}`;
    const percent = Math.round(ratio * 100);
    return `${stepLabel} ${bar} ${percent}%`;
  }

  private renderSummaryLine(width: number): string {
    const prefix = this.finalGlyph ?? phaseGlyph(this.currentPhase, this.useUnicode);
    const available = Math.max(width - stringWidth(prefix) - 1, 10);
    const summary = truncateToWidth(this.currentSummary || "Waiting…", available, this.useUnicode);
    return `${prefix} ${summary}`;
  }

  private renderTailLines(width: number): string[] {
    const results: string[] = [];
    for (let i = 0; i < TAIL_LINES; i++) {
      const line = this.tailLines[i] ?? "";
      results.push(truncateToWidth(line, width, this.useUnicode));
    }
    return results;
  }
}

function computeTailLines(text: string, width: number): string[] {
  if (!text) {
    return Array(TAIL_LINES).fill("");
  }
  const wrapped = wrapAnsi(text, Math.max(width, 20), { hard: true, trim: false });
  const lines = wrapped.split("\n").filter((line) => line.length > 0);
  const lastLines = lines.slice(-TAIL_LINES);
  while (lastLines.length < TAIL_LINES) {
    lastLines.unshift("");
  }
  return lastLines;
}

function phaseGlyph(phase: Phase, useUnicode: boolean): string {
  if (!useUnicode) {
    switch (phase) {
      case "processing":
        return "[..]";
      case "generating":
        return "[>>]";
      case "tool_running":
        return "[**]";
      case "idle":
        return "[->]";
      case "error":
      default:
        return "[!!]";
    }
  }
  switch (phase) {
    case "processing":
      return "⏳";
    case "generating":
      return "✎";
    case "tool_running":
      return "⚙";
    case "idle":
      return "►";
    case "error":
    default:
      return "✖";
  }
}

function statusSummary(
  status: "completed" | "failed" | "cancelled",
  reason: string | undefined,
  unicode: boolean,
): { text: string; phase: Phase; glyph?: string } {
  switch (status) {
    case "completed":
      return { text: "Built", phase: "idle", glyph: unicode ? "✔" : "[OK]" };
    case "failed":
      return {
        text: reason ? `Failed: ${reason}` : "Failed",
        phase: "error",
        glyph: unicode ? "✖" : "[!!]",
      };
    case "cancelled":
      return {
        text: reason ? `Cancelled: ${reason}` : "Cancelled",
        phase: "processing",
        glyph: unicode ? "■" : "[--]",
      };
    default:
      return { text: "", phase: "idle" };
  }
}

function truncateToWidth(text: string, maxWidth: number, unicode: boolean): string {
  if (stringWidth(text) <= maxWidth) {
    return text;
  }
  const ellipsis = unicode ? "…" : "...";
  const target = Math.max(maxWidth - stringWidth(ellipsis), 0);
  let result = "";
  let width = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (width + charWidth > target) {
      break;
    }
    result += char;
    width += charWidth;
  }
  return `${result}${ellipsis}`;
}

function shouldUpdateTail(type: string): boolean {
  return (
    type.includes("text") ||
    type.includes("thinking") ||
    type.includes("message_update") ||
    type.includes("message_delta") ||
    type.includes("assistant_message")
  );
}

function inferStreamName(type: string): string {
  if (type.includes("thinking")) {
    return "thinking";
  }
  return "text";
}

function nextPhaseForType(current: Phase, type: string): Phase | null {
  const normalized = type.toLowerCase();
  if (normalized.includes("text") || normalized.includes("thinking") || normalized.includes("message_update")) {
    if (current !== "error") {
      return "generating";
    }
    return null;
  }
  if (
    normalized.includes("tool_execution_start") ||
    normalized.includes("toolcall_start") ||
    normalized === "toolcall"
  ) {
    return "tool_running";
  }
  if (
    normalized.includes("tool_execution_end") ||
    normalized.includes("toolcall_end") ||
    normalized.includes("result")
  ) {
    return "processing";
  }
  if (
    normalized.includes("turn_end") ||
    normalized.includes("agent_end") ||
    normalized.includes("message_end")
  ) {
    if (current !== "error") {
      return "idle";
    }
    return null;
  }
  if (
    normalized.includes("turn_start") ||
    normalized.includes("agent_start") ||
    normalized.includes("session")
  ) {
    return "processing";
  }
  return null;
}

function extractContent(event: Record<string, unknown>): string | null {
  const candidates = collectStrings([
    event.delta,
    event.text,
    event.thinking,
    event.content,
    (event.message as Record<string, unknown> | undefined)?.delta,
    (event.message as Record<string, unknown> | undefined)?.text,
    (event.message as Record<string, unknown> | undefined)?.content,
  ]);
  return candidates.find((candidate) => candidate.trim().length > 0) ?? null;
}

function collectStrings(input: unknown): string[] {
  if (!input) {
    return [];
  }
  if (typeof input === "string") {
    return [input];
  }
  if (Array.isArray(input)) {
    return input.flatMap((value) => collectStrings(value));
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    const prioritized = [
      "text",
      "delta",
      "content",
      "thinking",
      "value",
      "message",
      "parts",
      "data",
    ];
    const orderedKeys = [...new Set([...prioritized, ...keys])];
    return orderedKeys.flatMap((key) => collectStrings(obj[key]));
  }
  return [];
}

function extractErrorMessage(event: Record<string, unknown>): string | null {
  if (typeof event.message === "string") {
    return event.message;
  }
  if (typeof event.error === "string") {
    return event.error;
  }
  if (typeof event.detail === "string") {
    return event.detail;
  }
  const data = event.data as Record<string, unknown> | undefined;
  if (data && typeof data.message === "string") {
    return data.message;
  }
  return null;
}

function applyPhaseTransition(display: ExecuteDisplay, type: string): void {
  const normalized = type.toLowerCase();
  if (normalized.includes("tool_execution_start") || normalized.includes("toolcall_start") || normalized === "toolcall") {
    setPhase(display, "tool_running");
    return;
  }
  if (normalized.includes("tool_execution_end") || normalized.includes("toolcall_end") || normalized.includes("result")) {
    setPhase(display, "processing");
    return;
  }
  if (normalized.includes("text") || normalized.includes("thinking") || normalized.includes("message_update")) {
    setPhase(display, "generating");
    return;
  }
  if (normalized.includes("turn_end") || normalized.includes("agent_end") || normalized.includes("message_end")) {
    setPhase(display, "idle");
    return;
  }
  if (normalized.includes("turn_start") || normalized.includes("agent_start") || normalized.includes("session")) {
    setPhase(display, "processing");
    return;
  }
}

function setPhase(display: ExecuteDisplay, phase: Phase): void {
  (display as any).currentPhase = phase;
  (display as any).render();
}

export function supportsUnicode(): boolean {
  if (process.platform === "win32") {
    return true;
  }
  const env = `${process.env.LC_ALL ?? ""}${process.env.LC_CTYPE ?? ""}${process.env.LANG ?? ""}`;
  return /utf-?8/i.test(env);
}
