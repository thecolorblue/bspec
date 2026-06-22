import type { Theme } from "@earendil-works/pi-coding-agent";
import { ensurePiPackageDir } from "./pi.ts";
import {
  applyTaskMutation,
  type TaskStatus,
} from "@juicesharp/rpiv-todo/todo.js";
import {
  selectHasActive,
  selectOverlayLayout,
  selectShowTaskIds,
  selectTasksByStatus,
  selectTodoCounts,
} from "@juicesharp/rpiv-todo/state/selectors.js";
import {
  EMPTY_STATE,
  type TaskState,
} from "@juicesharp/rpiv-todo/state/state.js";
import {
  formatStatusLabel,
  formatOverlayTaskLine,
  STATUS_GLYPH,
} from "@juicesharp/rpiv-todo/view/format.js";
import { t } from "@juicesharp/rpiv-todo/state/i18n-bridge.js";
import type { PlanGap, PlanStep } from "./schemas.ts";

type Status = Exclude<TaskStatus, "deleted">;

interface EnsureOptions {
  initialStatus?: Status;
  silent?: boolean;
}

interface StatusOptions {
  silent?: boolean;
}

type TaskKey = string;

const MAX_SUBJECT_LENGTH = 80;

/**
 * BuildTodoTracker mirrors build progress into rpiv-todo. Each plan step and gap
 * appears as a concise todo entry; statuses flip to reflect cached, running, and
 * completed blocks.
 */
export class BuildTodoTracker {
  private readonly enabled: boolean;
  private readonly write: (text: string) => void;
  private state: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
  private readonly idsByKey = new Map<TaskKey, number>();
  private lastRender = "";
  private renderedLines = 0;
  private dirty = false;
  private readonly theme?: Theme;

  constructor(opts?: { enabled?: boolean; stream?: NodeJS.WriteStream; theme?: Theme }) {
    const stream = opts?.stream ?? process.stderr;
    this.enabled = opts?.enabled ?? (Boolean(stream.isTTY) && Boolean(process.stdout.isTTY));
    this.write = (text) => stream.write(text);
    this.theme = this.enabled ? opts?.theme : undefined;
  }

  /**
   * Async factory that loads Pi's `Theme` for the colorized overlay before
   * constructing the tracker. The theme is loaded lazily here (not via a
   * top-level import) so importing this module never triggers Pi's config init,
   * and via `await import` rather than `require` so `bun build --compile` can
   * bundle the ESM-only Pi package. When the overlay is disabled (non-TTY) Pi is
   * never touched, keeping cached builds offline.
   */
  static async create(
    opts?: { enabled?: boolean; stream?: NodeJS.WriteStream },
  ): Promise<BuildTodoTracker> {
    const stream = opts?.stream ?? process.stderr;
    const enabled =
      opts?.enabled ?? (Boolean(stream.isTTY) && Boolean(process.stdout.isTTY));
    const theme = enabled ? await loadTheme() : undefined;
    return new BuildTodoTracker({ enabled, stream, theme });
  }

  seedGaps(gaps: PlanGap[]): void {
    if (!this.enabled || gaps.length === 0) return;
    gaps.forEach((gap, index) => {
      this.ensureGapTask(index, gap, { silent: true });
    });
    this.render(true);
  }

  ensureStepTask(step: PlanStep, options: EnsureOptions = {}): void {
    this.ensureTask(this.stepKey(step), this.describeStep(step), options);
  }

  ensureGapTask(index: number, gap: PlanGap, options: EnsureOptions = {}): void {
    this.ensureTask(this.gapKey(index), this.describeGap(gap), options);
  }

  promoteGapToStep(index: number, step: PlanStep): void {
    if (!this.enabled) return;
    const fromKey = this.gapKey(index);
    const id = this.idsByKey.get(fromKey);
    if (id === undefined) {
      // Gap task might not exist (e.g. no UI); nothing to promote.
      return;
    }

    const toKey = this.stepKey(step);
    this.idsByKey.delete(fromKey);
    this.idsByKey.set(toKey, id);
    this.updateSubjectById(id, this.describeStep(step));
  }

  markGapPending(index: number, opts: StatusOptions = {}): void {
    this.setStatusByKey(this.gapKey(index), "pending", opts);
  }

  markGapInProgress(index: number, opts: StatusOptions = {}): void {
    this.setStatusByKey(this.gapKey(index), "in_progress", opts);
  }

  markStepPending(step: PlanStep, opts: StatusOptions = {}): void {
    this.setStatusByKey(this.stepKey(step), "pending", opts);
  }

  markStepInProgress(step: PlanStep, opts: StatusOptions = {}): void {
    this.setStatusByKey(this.stepKey(step), "in_progress", opts);
  }

  markStepCompleted(step: PlanStep, opts: StatusOptions = {}): void {
    this.setStatusByKey(this.stepKey(step), "completed", opts);
  }

  render(force = false): void {
    if (!this.enabled) return;
    if (!this.dirty && !force) return;

    if (this.theme) this.renderWithTheme(this.theme, force);
    else this.renderPlain(force);
  }

  dispose(): void {
    if (!this.enabled) return;
    if (this.dirty) this.render(true);
  }

  private renderWithTheme(theme: Theme, force: boolean): void {
    const counts = selectTodoCounts(this.state);
    if (counts.total === 0) {
      if (this.lastRender !== "" || this.renderedLines > 0 || force) {
        this.replaceOutput("");
      } else {
        this.dirty = false;
      }
      return;
    }

    const hasActive = selectHasActive(this.state);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = theme.fg(headingColor, hasActive ? "●" : "○");
    const headingText = theme.fg(
      headingColor,
      `${t("overlay.heading", "Todos")} (${counts.completed}/${counts.total})`,
    );

    const visibleState: TaskState = {
      tasks: this.state.tasks.filter((t) => t.status !== "deleted"),
      nextId: this.state.nextId,
    };
    const showIds = selectShowTaskIds(visibleState);
    const layout = selectOverlayLayout(visibleState, 11);

    const lines: string[] = [`${headingIcon} ${headingText}`];

    const renderPrefix = (idx: number, lastIndex: number, hasSummary: boolean): string => {
      const isLast = idx === lastIndex && !hasSummary;
      const glyph = isLast ? "└─" : "├─";
      return theme.fg("dim", glyph);
    };

    const visible = layout.visible;
    const hasSummary = layout.hiddenCompleted > 0 || layout.truncatedTail > 0;
    visible.forEach((task, index) => {
      const prefix = renderPrefix(index, visible.length - 1, hasSummary);
      const line = `${prefix} ${formatOverlayTaskLine(task, theme, showIds)}`;
      lines.push(line);
    });

    if (hasSummary) {
      const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
      const parts: string[] = [];
      if (layout.hiddenCompleted > 0) {
        parts.push(
          `${layout.hiddenCompleted} ${theme.fg("dim", formatStatusLabel("completed"))}`,
        );
      }
      if (layout.truncatedTail > 0) {
        parts.push(`${layout.truncatedTail} ${theme.fg("dim", formatStatusLabel("pending"))}`);
      }
      const summaryText =
        parts.length > 0
          ? `+${totalHidden} ${t("overlay.more", "more")} (${parts.join(", ")})`
          : `+${totalHidden} ${t("overlay.more", "more")}`;
      lines.push(`${theme.fg("dim", "└─")} ${theme.fg("dim", summaryText)}`);
    }

    const output = lines.join("\n");
    if (force || output !== this.lastRender) this.replaceOutput(output);
    else this.dirty = false;
  }

  private renderPlain(force: boolean): void {
    const counts = selectTodoCounts(this.state);
    if (counts.total === 0) {
      if (this.lastRender !== "" || this.renderedLines > 0 || force) {
        this.replaceOutput("");
      } else {
        this.dirty = false;
      }
      return;
    }

    const lines: string[] = [];
    lines.push(`Todos (${counts.completed}/${counts.total})`);

    const groups = selectTasksByStatus(this.state);
    const ordered = [
      ...groups.inProgress,
      ...groups.pending,
      ...groups.completed,
    ];
    for (const task of ordered) {
      const glyph = STATUS_GLYPH[task.status];
      const label = formatStatusLabel(task.status);
      lines.push(`  ${glyph} ${task.subject} — ${label}`);
    }

    const output = lines.join("\n");
    if (force || output !== this.lastRender) this.replaceOutput(output);
    else this.dirty = false;
  }

  private replaceOutput(output: string): void {
    const lineCount = output === "" ? 0 : output.split("\n").length;
    if (this.renderedLines > 0) {
      this.write(`\x1b[${this.renderedLines}F`);
      for (let i = 0; i < this.renderedLines; i++) {
        this.write("\x1b[2K");
        if (i < this.renderedLines - 1) this.write("\x1b[1E");
      }
      if (this.renderedLines > 1) this.write(`\x1b[${this.renderedLines - 1}F`);
      else this.write("\r");
    }

    if (lineCount > 0) {
      this.write("\n");
      this.write(output);
      this.write("\n");
      this.renderedLines = lineCount + 1;
      this.lastRender = output;
    } else {
      this.renderedLines = 0;
      this.lastRender = "";
    }
    this.dirty = false;
  }

  private ensureTask(key: TaskKey, subject: string, options: EnsureOptions): void {
    if (!this.enabled) return;
    const trimmedSubject = this.truncate(subject.trim());
    const existingId = this.idsByKey.get(key);
    if (existingId !== undefined) {
      this.updateSubjectById(existingId, trimmedSubject);
      if (options.initialStatus) {
        this.setStatusById(existingId, options.initialStatus, { silent: true });
      }
      if (!options.silent) this.render();
      return;
    }

    const result = applyTaskMutation(this.state, "create", { subject: trimmedSubject });
    if (result.op.kind === "error") {
      this.reportReducerError(result.op.message);
      return;
    }
    if (result.op.kind !== "create") {
      this.reportReducerError("unexpected reducer outcome while creating task");
      return;
    }

    this.state = result.state;
    this.idsByKey.set(key, result.op.taskId);

    const status = options.initialStatus ?? "pending";
    if (status !== "pending") {
      this.setStatusById(result.op.taskId, status, { silent: true });
    }

    this.dirty = true;
    if (!options.silent) this.render();
  }

  private setStatusByKey(key: TaskKey, status: Status, opts: StatusOptions): void {
    if (!this.enabled) return;
    const id = this.idsByKey.get(key);
    if (id === undefined) return;
    this.setStatusById(id, status, opts);
  }

  private setStatusById(id: number, status: Status, opts: StatusOptions): void {
    const task = this.findTask(id);
    if (!task || task.status === status) {
      if (!opts.silent) this.render();
      return;
    }
    const result = applyTaskMutation(this.state, "update", { id, status });
    if (result.op.kind === "error") {
      this.reportReducerError(result.op.message);
      return;
    }
    if (result.op.kind !== "update") {
      this.reportReducerError("unexpected reducer outcome while updating task");
      return;
    }
    this.state = result.state;
    this.dirty = true;
    if (!opts.silent) this.render();
  }

  private updateSubjectById(id: number, subject: string): void {
    const task = this.findTask(id);
    if (!task) return;
    const trimmed = this.truncate(subject.trim());
    if (task.subject === trimmed) return;
    const result = applyTaskMutation(this.state, "update", { id, subject: trimmed });
    if (result.op.kind === "error") {
      this.reportReducerError(result.op.message);
      return;
    }
    if (result.op.kind !== "update") {
      this.reportReducerError("unexpected reducer outcome while renaming task");
      return;
    }
    this.state = result.state;
    this.dirty = true;
  }

  private findTask(id: number) {
    return this.state.tasks.find((t) => t.id === id);
  }

  private describeStep(step: PlanStep): string {
    const summary = step.summary?.trim();
    if (summary && summary.length > 0) {
      return `${summary} (${step.id}@${step.version})`;
    }
    return `Build ${step.id}@${step.version}`;
  }

  private describeGap(gap: PlanGap): string {
    const base = gap.feature.split(" — ")[0]?.trim() ?? gap.feature.trim();
    return `Author: ${base}`;
  }

  private stepKey(step: PlanStep): TaskKey {
    return `step:${step.id}@${step.version}`;
  }

  private gapKey(index: number): TaskKey {
    return `gap:${index}`;
  }

  private truncate(subject: string): string {
    if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
    return `${subject.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;
  }

  private reportReducerError(message: string): void {
    this.write(`\n[warning] todo tracker error: ${message}\n`);
  }
}

/**
 * Load Pi's `Theme` class and instantiate the overlay theme. `ensurePiPackageDir`
 * runs first so Pi's module init can find its package.json inside the compiled
 * binary; `await import` keeps the ESM-only package resolvable by `bun --compile`.
 */
async function loadTheme(): Promise<Theme> {
  ensurePiPackageDir();
  const { Theme } = await import("@earendil-works/pi-coding-agent");
  return buildTheme(Theme);
}

function buildTheme(Theme: typeof import("@earendil-works/pi-coding-agent").Theme): Theme {
  const fg: Record<string, string> = {
    accent: "#7aa2f7",
    border: "#3b4261",
    borderAccent: "#7aa2f7",
    borderMuted: "#2a2e42",
    success: "#9ece6a",
    error: "#f7768e",
    warning: "#e0af68",
    muted: "#565f89",
    dim: "#414868",
    text: "#c0caf5",
    thinkingText: "#9aa5ce",
    userMessageText: "#c0caf5",
    customMessageText: "#c0caf5",
    customMessageLabel: "#7aa2f7",
    toolTitle: "#7dcfff",
    toolOutput: "#a9b1d6",
    mdHeading: "#7aa2f7",
    mdLink: "#7dcfff",
    mdLinkUrl: "#565f89",
    mdCode: "#bb9af7",
    mdCodeBlock: "#c0caf5",
    mdCodeBlockBorder: "#3b4261",
    mdQuote: "#9aa5ce",
    mdQuoteBorder: "#565f89",
    mdHr: "#3b4261",
    mdListBullet: "#7aa2f7",
    toolDiffAdded: "#9ece6a",
    toolDiffRemoved: "#f7768e",
    toolDiffContext: "#565f89",
    syntaxComment: "#565f89",
    syntaxKeyword: "#bb9af7",
    syntaxFunction: "#7aa2f7",
    syntaxVariable: "#c0caf5",
    syntaxString: "#9ece6a",
    syntaxNumber: "#ff9e64",
    syntaxType: "#2ac3de",
    syntaxOperator: "#89ddff",
    syntaxPunctuation: "#a9b1d6",
    thinkingOff: "#565f89",
    thinkingMinimal: "#7aa2f7",
    thinkingLow: "#7dcfff",
    thinkingMedium: "#e0af68",
    thinkingHigh: "#ff9e64",
    thinkingXhigh: "#f7768e",
    bashMode: "#9ece6a",
  };
  const bg: Record<string, string> = {
    selectedBg: "#283457",
    userMessageBg: "#1f2335",
    customMessageBg: "#1f2335",
    toolPendingBg: "#2a2e42",
    toolSuccessBg: "#1f3a2b",
    toolErrorBg: "#3a1f2b",
  };
  return new Theme(fg as never, bg as never, "truecolor");
}
