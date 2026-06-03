import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import YAML from "yaml";
import { Question, SpecFile } from "./types.js";

interface ParsedQuestionBlock {
  start: number;
  end: number;
  content: string;
  startLineForError: number;
}

interface Fence {
  char: string;
  length: number;
  info: string;
  start: number;
}

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecParseError";
  }
}

export async function parseSpecFile(specPath: string): Promise<SpecFile> {
  const absolutePath = path.resolve(specPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const lines = raw.split(/\r?\n/);

  const { blocks, bodyLines, skipSet } = extractQuestionBlocks(lines);
  const questions = parseQuestions(blocks, absolutePath);

  const title = extractTitle(lines);
  const summary = extractSummary(lines, skipSet);

  const bodyWithoutQuestions = bodyLines.join("\n");
  const checksum = crypto.createHash("sha256").update(raw, "utf8").digest("hex");

  return {
    path: absolutePath,
    raw_markdown: raw,
    title,
    summary,
    questions,
    body_without_questions: bodyWithoutQuestions,
    checksum_sha256: checksum,
  };
}

function extractQuestionBlocks(lines: string[]): {
  blocks: ParsedQuestionBlock[];
  bodyLines: string[];
  skipSet: Set<number>;
} {
  const openFences: Fence[] = [];
  const blocks: ParsedQuestionBlock[] = [];
  const skipIndices = new Set<number>();
  let activeBlock: {
    fence: Fence;
    start: number;
    lines: string[];
    startLineForError: number;
  } | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const match = line.match(/^(\s*)([`~]{3,})(.*)$/);
    if (match) {
      const [, , fenceSeq, infoRaw] = match;
      const char = fenceSeq[0]!;
      const fenceLength = fenceSeq.length;
      const info = infoRaw.trim();
      const top = openFences[openFences.length - 1];
      const isClosing =
        top &&
        top.char === char &&
        fenceLength >= top.length &&
        info === "";

      if (isClosing) {
        if (activeBlock && activeBlock.fence === top) {
          skipIndices.add(idx);
          blocks.push({
            start: activeBlock.start,
            end: idx,
            content: activeBlock.lines.join("\n"),
            startLineForError: activeBlock.startLineForError,
          });
          activeBlock = null;
        } else if (activeBlock) {
          activeBlock.lines.push(line);
          skipIndices.add(idx);
        }
        openFences.pop();
        continue;
      }

      const fence: Fence = {
        char,
        length: fenceLength,
        info,
        start: idx,
      };
      const isTopLevel = openFences.length === 0;
      openFences.push(fence);

      if (info === "prebuild-questions" && isTopLevel) {
        activeBlock = {
          fence,
          start: idx,
          lines: [],
          startLineForError: idx + 2, // first content line in 1-based terms
        };
        skipIndices.add(idx);
      } else if (activeBlock) {
        activeBlock.lines.push(line);
        skipIndices.add(idx);
      }
      continue;
    }

    if (activeBlock) {
      activeBlock.lines.push(line);
      skipIndices.add(idx);
    }
  }

  if (activeBlock) {
    throw new SpecParseError(
      `Unclosed prebuild-questions block starting at line ${activeBlock.start + 1}`,
    );
  }

  const bodyLines = lines.filter((_, idx) => !skipIndices.has(idx));

  return { blocks, bodyLines, skipSet: skipIndices };
}

function parseQuestions(blocks: ParsedQuestionBlock[], specPath: string): Question[] {
  const questions: Question[] = [];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(block.content) ?? [];
    } catch (error) {
      const err = error as Error;
      throw new SpecParseError(
        `Failed to parse prebuild-questions block starting at line ${block.startLineForError} in ${specPath}: ${err.message}`,
      );
    }

    if (!Array.isArray(parsed)) {
      throw new SpecParseError(
        `Expected questions block at line ${block.startLineForError} to be a YAML array.`,
      );
    }

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const question = normaliseQuestion(entry);
      questions.push(question);
    }
  }
  return questions;
}

function normaliseQuestion(raw: Record<string, unknown>): Question {
  const id = String(raw.id ?? "").trim();
  if (!id) {
    throw new SpecParseError("Question is missing required field 'id'.");
  }
  const prompt = String(raw.prompt ?? "").trim();
  if (!prompt) {
    throw new SpecParseError(`Question "${id}" is missing required field 'prompt'.`);
  }
  const kind = String(raw.kind ?? "").trim() as Question["kind"];
  const allowedKinds: Question["kind"][] = [
    "single_select",
    "multi_select",
    "text",
    "path",
    "bool",
    "number",
  ];
  if (!allowedKinds.includes(kind)) {
    throw new SpecParseError(`Question "${id}" has unsupported kind "${kind}".`);
  }

  const help =
    raw.help === undefined || raw.help === null ? null : String(raw.help);

  let options: Question["options"] = null;
  if (Array.isArray(raw.options)) {
    options = raw.options.map((option) => {
      if (!option || typeof option !== "object") {
        throw new SpecParseError(`Question "${id}" has an invalid option.`);
      }
      const value = String(option.value ?? "").trim();
      if (!value) {
        throw new SpecParseError(`Question "${id}" has an option without a value.`);
      }
      const label = option.label ? String(option.label) : value;
      const description =
        option.description === undefined || option.description === null
          ? null
          : String(option.description);
      return { value, label, description };
    });
  } else if (kind === "single_select" || kind === "multi_select") {
    throw new SpecParseError(`Question "${id}" must provide an options array.`);
  }

  const validation = raw.validation ?? null;
  let normalisedValidation: Question["validation"] = null;
  if (validation && typeof validation === "object") {
    const validationRecord = validation as Record<string, unknown>;
    normalisedValidation = {
      regex:
        typeof validationRecord.regex === "string"
          ? String(validationRecord.regex)
          : undefined,
      min:
        typeof validationRecord.min === "number"
          ? Number(validationRecord.min)
          : undefined,
      max:
        typeof validationRecord.max === "number"
          ? Number(validationRecord.max)
          : undefined,
      must_exist:
        typeof validationRecord.must_exist === "boolean"
          ? (validationRecord.must_exist as boolean)
          : undefined,
    };
  }

  let depends_on = raw.depends_on ?? [];
  if (!Array.isArray(depends_on)) {
    depends_on = [];
  }
  const dependencies = (depends_on as unknown[]).flatMap((dep) => {
    if (!dep || typeof dep !== "object") {
      return [];
    }
    const questionId = String((dep as Record<string, unknown>).question_id ?? "").trim();
    if (!questionId) {
      return [];
    }
    return [
      {
        question_id: questionId,
        equals: (dep as Record<string, unknown>).equals,
      },
    ];
  });

  return {
    id,
    prompt,
    help,
    kind,
    options,
    default: raw.default ?? undefined,
    required: Boolean(raw.required),
    validation: normalisedValidation,
    depends_on: dependencies,
  };
}

function extractTitle(lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim();
    }
  }
  throw new SpecParseError("SPEC.md must start with a level-1 heading (# Title).");
}

function extractSummary(lines: string[], skipSet: Set<number>): string {
  let titleIndex = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx]?.trim() ?? "";
    if (trimmed.startsWith("# ")) {
      titleIndex = idx;
      break;
    }
  }
  if (titleIndex === -1) {
    return "";
  }

  let cursor = titleIndex + 1;
  while (cursor < lines.length) {
    if (skipSet.has(cursor)) {
      cursor++;
      continue;
    }
    const trimmed = lines[cursor]?.trim() ?? "";
    if (trimmed.length === 0) {
      cursor++;
      continue;
    }
    const paragraph: string[] = [];
    while (cursor < lines.length) {
      if (skipSet.has(cursor)) {
        cursor++;
        continue;
      }
      const text = lines[cursor] ?? "";
      if (text.trim().length === 0) {
        break;
      }
      paragraph.push(text.trim());
      cursor++;
    }
    if (paragraph.length === 0) {
      break;
    }
    return paragraph.join(" ");
  }
  return "";
}
