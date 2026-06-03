import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Answer, BuildTarget, ResolvedSpec, SpecFile, TargetOs } from "./types.js";
import fs from "fs-extra";
import { expandPath } from "./question-runner.js";

interface BuildTargetAnswers {
  os?: TargetOs;
  language?: string;
  ui_paradigm?: string;
  data_dir?: string;
}

export async function resolveSpec(spec: SpecFile, answers: Answer[]): Promise<ResolvedSpec> {
  const answerMap = new Map<string, Answer>();
  for (const answer of answers) {
    answerMap.set(answer.questionId, answer);
  }

  const target = buildTarget(answerMap);
  const outputDir = resolveOutputDir(answerMap);

  await ensureOutputDirectory(outputDir);

  const frontmatter = {
    spec_sha256: spec.checksum_sha256,
    resolved_at: new Date().toISOString(),
    build_target: target,
    answers: answers.map((answer) => ({
      id: answer.questionId,
      value: serialiseAnswerValue(answer.value),
    })),
  };

  const yamlFrontmatter = YAML.stringify(frontmatter).trimEnd();
  const resolvedMarkdown = `---\n${yamlFrontmatter}\n---\n\n${spec.body_without_questions}`;

  return {
    spec,
    answers,
    target,
    output_dir: outputDir,
    resolved_markdown: resolvedMarkdown,
  };
}

function buildTarget(answerMap: Map<string, Answer>): BuildTarget {
  const partial: BuildTargetAnswers = {};
  const targetOsAnswer = answerMap.get("target_os")?.value;
  if (!targetOsAnswer || typeof targetOsAnswer !== "string") {
    throw new Error("Missing answer for required question 'target_os'.");
  }
  partial.os = normaliseTargetOs(targetOsAnswer);

  const languageAnswer = answerMap.get("language")?.value;
  if (!languageAnswer || typeof languageAnswer !== "string") {
    throw new Error("Missing answer for required question 'language'.");
  }
  partial.language = languageAnswer;

  const uiAnswer = answerMap.get("ui_paradigm")?.value;
  if (uiAnswer && typeof uiAnswer === "string") {
    partial.ui_paradigm = uiAnswer;
  }

  const dataDirAnswer = answerMap.get("data_dir")?.value;
  if (dataDirAnswer && typeof dataDirAnswer === "string") {
    partial.data_dir = expandPath(dataDirAnswer);
  }

  return {
    os: partial.os,
    language: partial.language,
    ui_paradigm: partial.ui_paradigm as BuildTarget["ui_paradigm"],
    data_dir: partial.data_dir,
  };
}

function resolveOutputDir(answerMap: Map<string, Answer>): string {
  const answer = answerMap.get("output_dir");
  if (!answer || typeof answer.value !== "string" || !answer.value) {
    throw new Error("Missing answer for required question 'output_dir'.");
  }
  return expandPath(answer.value);
}

function serialiseAnswerValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => serialiseAnswerValue(item));
  }
  if (value && typeof value === "object") {
    return value;
  }
  return value;
}

function normaliseTargetOs(value: string): TargetOs {
  switch (value) {
    case "macos":
    case "linux":
    case "windows":
      return value;
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

async function ensureOutputDirectory(dir: string): Promise<void> {
  await fs.ensureDir(dir);
  try {
    await fs.access(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`Output directory "${dir}" is not writable by the current user.`);
  }
  if (isSystemPath(dir)) {
    throw new Error("Output directory must be inside user space, not a system path.");
  }
}

function isSystemPath(p: string): boolean {
  const resolved = path.resolve(p);
  if (process.platform === "win32") {
    const upper = resolved.toUpperCase();
    if (upper === "C:\\" || upper === "C:\\WINDOWS" || upper.startsWith("C:\\PROGRAM FILES")) {
      return true;
    }
    return false;
  }
  if (resolved === "/") {
    return true;
  }
  if (resolved.startsWith("/System/") || resolved.startsWith("/usr/") || resolved.startsWith("/bin/")) {
    return true;
  }
  if (resolved.startsWith(os.homedir())) {
    return false;
  }
  return false;
}
