import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { Question, Answer, SpecFile, TargetOs } from "./types.js";

const TARGET_OS_OPTIONS: Record<TargetOs, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

const DEFAULT_LANGUAGE_OPTIONS: Record<TargetOs, { value: string; label: string }[]> = {
  macos: [
    { value: "typescript", label: "TypeScript (Node.js)" },
    { value: "swift", label: "Swift" },
    { value: "python", label: "Python" },
  ],
  linux: [
    { value: "typescript", label: "TypeScript (Node.js)" },
    { value: "python", label: "Python" },
    { value: "go", label: "Go" },
  ],
  windows: [
    { value: "typescript", label: "TypeScript (Node.js)" },
    { value: "csharp", label: "C# (.NET)" },
    { value: "python", label: "Python" },
  ],
};

export interface QuestionRunOptions {
  defaults?: Record<string, unknown>;
  nonInteractive?: boolean;
}

const RESERVED_IDS = new Set(["target_os", "language", "ui_paradigm", "data_dir", "output_dir"]);

export async function runQuestions(spec: SpecFile, options: QuestionRunOptions = {}): Promise<Answer[]> {
  const combinedQuestions = injectReservedQuestions(spec);
  const answers: Answer[] = [];
  const answerMap = new Map<string, Answer>();

  for (const question of combinedQuestions) {
    if (!shouldAskQuestion(question, answerMap)) {
      continue;
    }

    let value: unknown;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      value = await promptForQuestion(question, options.defaults?.[question.id]);
      const validationError = await validateAnswer(question, value);
      if (validationError) {
        console.error(chalk.red(validationError));
        continue;
      }
      break;
    }

    if (question.kind === "path" && typeof value === "string") {
      value = expandPath(value);
    }

    const answer: Answer = {
      questionId: question.id,
      value,
      question,
    };
    answers.push(answer);
    answerMap.set(question.id, answer);
  }

  return answers;
}

function shouldAskQuestion(question: Question, answerMap: Map<string, Answer>): boolean {
  if (!question.depends_on || question.depends_on.length === 0) {
    return true;
  }
  for (const dependency of question.depends_on) {
    const resolved = answerMap.get(dependency.question_id);
    if (!resolved) {
      return false;
    }
    if (resolved.value !== dependency.equals) {
      return false;
    }
  }
  return true;
}

function injectReservedQuestions(spec: SpecFile): Question[] {
  const seen = new Set(spec.questions.map((q) => q.id));
  const questions: Question[] = [];
  const hostOs = detectHostOs();

  if (!seen.has("target_os")) {
    questions.push(createTargetOsQuestion(hostOs));
  }

  if (!seen.has("language")) {
    questions.push(createLanguageQuestion(hostOs));
  }

  questions.push(...spec.questions);

  if (!seen.has("output_dir")) {
    questions.push(createOutputDirQuestion(spec));
  }

  return questions;
}

function detectHostOs(): TargetOs {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function createTargetOsQuestion(hostOs: TargetOs): Question {
  return {
    id: "target_os",
    prompt: "Which operating system are you building for?",
    kind: "single_select",
    required: true,
    options: (["macos", "linux", "windows"] as TargetOs[]).map((value) => ({
      value,
      label: TARGET_OS_OPTIONS[value],
      description: value === hostOs ? "(detected host)" : null,
    })),
    default: hostOs,
  };
}

function createLanguageQuestion(hostOs: TargetOs): Question {
  const options = DEFAULT_LANGUAGE_OPTIONS[hostOs];
  const defaultValue = options[0]?.value ?? "typescript";
  return {
    id: "language",
    prompt: "Preferred implementation language?",
    kind: "single_select",
    required: true,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      description: null,
    })),
    default: defaultValue,
  };
}

function createOutputDirQuestion(spec: SpecFile): Question {
  const slug = slugify(spec.title);
  const defaultPath = path.join("~", "projects", slug);
  return {
    id: "output_dir",
    prompt: "Where should the agent write the project?",
    kind: "path",
    required: true,
    default: defaultPath,
    validation: {
      must_exist: false,
    },
  };
}

async function promptForQuestion(question: Question, defaultValue: unknown): Promise<unknown> {
  const message = formatPromptMessage(question);
  switch (question.kind) {
    case "single_select":
      {
        const defaultRaw = question.default ?? defaultValue;
        const defaultOption = typeof defaultRaw === "string" ? defaultRaw : undefined;
        return select<string>({
          message,
          loop: false,
          default: defaultOption as unknown,
          choices:
            question.options?.map((option) => ({
              name: option.label ?? option.value,
              value: option.value,
              description: option.description ?? undefined,
            })) ?? [],
        });
      }
    case "multi_select":
      {
        const rawDefault = question.default ?? defaultValue;
        const defaults = new Set(
          Array.isArray(rawDefault) ? rawDefault.map((item) => String(item)) : [],
        );
        return checkbox<string>({
          message,
          loop: false,
          choices:
            question.options?.map((option) => ({
              name: option.label ?? option.value,
              value: option.value,
              checked: defaults.has(option.value),
            })) ?? [],
        });
      }
    case "bool":
      return confirm({
        message,
        default: Boolean(question.default ?? defaultValue),
      });
    case "number": {
      const raw = await input({
        message,
        default: (question.default ?? defaultValue)?.toString(),
      });
      return raw === "" ? null : Number(raw);
    }
    case "path":
    case "text": {
      const raw = await input({
        message,
        default: (question.default ?? defaultValue)?.toString(),
      });
      return raw;
    }
    default:
      return input({
        message,
        default: (question.default ?? defaultValue)?.toString(),
      });
  }
}

function formatPromptMessage(question: Question): string {
  if (!question.help) {
    return question.prompt;
  }
  return `${question.prompt}\n${chalk.dim(question.help)}`;
}

async function validateAnswer(question: Question, value: unknown): Promise<string | null> {
  if (value === null || value === undefined || value === "") {
    if (question.required) {
      return "This question requires an answer.";
    }
    return null;
  }

  if (question.validation) {
    if (question.kind === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return "Enter a valid number.";
      }
      if (question.validation.min !== undefined && value < question.validation.min) {
        return `Value must be ≥ ${question.validation.min}.`;
      }
      if (question.validation.max !== undefined && value > question.validation.max) {
        return `Value must be ≤ ${question.validation.max}.`;
      }
    } else if (question.kind === "text" || question.kind === "path") {
      const textValue = String(value);
      if (question.validation.regex) {
        const regex = new RegExp(question.validation.regex);
        if (!regex.test(textValue)) {
          return "Answer does not match the required format.";
        }
      }
      if (question.validation.min !== undefined && textValue.length < question.validation.min) {
        return `Answer must be at least ${question.validation.min} characters.`;
      }
      if (question.validation.max !== undefined && textValue.length > question.validation.max) {
        return `Answer must be at most ${question.validation.max} characters.`;
      }
      if (question.kind === "path" && question.validation.must_exist) {
        const expanded = expandPath(textValue);
        if (!(await fs.pathExists(expanded))) {
          return `Path "${textValue}" does not exist.`;
        }
      }
    } else if (question.kind === "multi_select") {
      if (!Array.isArray(value)) {
        return "Select at least one option.";
      }
      if (question.validation.min !== undefined && value.length < question.validation.min) {
        return `Select at least ${question.validation.min} option(s).`;
      }
      if (question.validation.max !== undefined && value.length > question.validation.max) {
        return `Select no more than ${question.validation.max} option(s).`;
      }
    }
  }

  if (question.kind === "path") {
    const expanded = expandPath(String(value));
    if (isSystemPath(expanded)) {
      return "Choose a project directory within your user space, not a system path.";
    }
  }

  return null;
}

export function expandPath(p: string): string {
  if (!p) {
    return p;
  }
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return path.resolve(p);
}

function isSystemPath(p: string): boolean {
  const normal = path.resolve(p);
  if (process.platform === "win32") {
    const upper = normal.toUpperCase();
    return upper === "C:\\" || upper.startsWith("C:\\WINDOWS");
  }
  return normal === "/" || normal.startsWith("/usr/") || normal.startsWith("/System/");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-")
    .trim() || "project";
}
