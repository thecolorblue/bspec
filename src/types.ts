export type ProviderId = "anthropic" | "openai" | "google" | "openrouter";

export interface QuestionOption {
  value: string;
  label: string;
  description?: string | null;
}

export type QuestionKind =
  | "single_select"
  | "multi_select"
  | "text"
  | "path"
  | "bool"
  | "number";

export interface QuestionValidation {
  regex?: string;
  min?: number;
  max?: number;
  must_exist?: boolean;
}

export interface QuestionDependency {
  question_id: string;
  equals: unknown;
}

export interface Question {
  id: string;
  prompt: string;
  help?: string | null;
  kind: QuestionKind;
  options?: QuestionOption[] | null;
  default?: unknown;
  required?: boolean;
  validation?: QuestionValidation | null;
  depends_on?: QuestionDependency[];
}

export interface SpecFile {
  path: string;
  raw_markdown: string;
  title: string;
  summary: string;
  questions: Question[];
  body_without_questions: string;
  checksum_sha256: string;
}

export type TargetOs = "macos" | "linux" | "windows";

export type UiParadigm = "cli" | "tui" | "desktop" | "web" | "library";

export interface BuildTarget {
  os: TargetOs;
  language: string;
  ui_paradigm?: UiParadigm;
  data_dir?: string;
}

export interface Answer {
  questionId: string;
  value: unknown;
  question: Question;
}

export interface ResolvedSpec {
  spec: SpecFile;
  answers: Answer[];
  target: BuildTarget;
  output_dir: string;
  resolved_markdown: string;
}

export type AgentStepKind =
  | "model_request"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "status"
  | "error"
  | "checkpoint";

export interface AgentStep {
  seq: number;
  ts: string;
  kind: AgentStepKind;
  payload: Record<string, unknown>;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_ms: number | null;
}

export interface PlanStep {
  index: number;
  text: string;
}

export interface BuildSessionSummary {
  id: string;
  provider: ProviderId;
  model: string;
  specPath: string;
  outputDir: string;
  status: "queued" | "planning" | "awaiting_approval" | "executing" | "repair" | "completed" | "failed" | "cancelled";
  startedAt: string;
  updatedAt: string;
  stepCount?: number;
  error?: string;
}
