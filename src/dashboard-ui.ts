import {
  BorderedLoader,
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  ScrollView,
  type SelectItem,
  SelectList,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  DashboardCancelledError,
  formatGoalCounts,
  type DashboardEvent,
  type DashboardGoal,
  type DashboardGoalDetail,
  type DashboardSnapshot,
  type DashboardStep,
  type DashboardStepHistory,
} from "./dashboard-data.ts";
import {
  PkmReferenceReader,
  type PkmReferenceReaderLike,
  type PkmTaskReference,
} from "./pkm-reference.ts";
import { spoolUserFacingError, type RuntimeIdentity } from "./spool-service.ts";

export interface DashboardReaderLike {
  loadGoals(signal?: AbortSignal): Promise<DashboardSnapshot>;
  loadGoal(
    goal: DashboardGoal,
    viewer: RuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<DashboardGoalDetail>;
  loadStep(
    goal: DashboardGoal,
    step: DashboardStep,
    viewer: RuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<DashboardStepHistory>;
  close(): Promise<void>;
}

type SelectResult =
  | { action: "select"; value: string }
  | { action: "reference"; value: string }
  | { action: "refresh" }
  | { action: "back" };

type LoadResult<T> =
  | { kind: "loaded"; value: T }
  | { kind: "cancelled" }
  | { kind: "error"; error: Error };

interface GoalBrowserSnapshot {
  dashboard: DashboardSnapshot;
  references: ReadonlyMap<string, PkmTaskReference>;
}

export async function runSpoolDashboard(
  ctx: ExtensionCommandContext,
  reader: DashboardReaderLike,
  viewer: RuntimeIdentity,
  pkmReader: PkmReferenceReaderLike = new PkmReferenceReader(),
): Promise<void> {
  let goals: GoalBrowserSnapshot | undefined;
  while (true) {
    if (!goals) {
      const loaded = await loadWithUi(ctx, "Loading Spool work log...", (signal) =>
        loadGoalBrowserSnapshot(reader, pkmReader, signal),
      );
      if (loaded.kind === "cancelled") return;
      if (loaded.kind === "error") {
        const action = await showError(ctx, loaded.error, false);
        if (action === "refresh") continue;
        return;
      }
      goals = loaded.value;
    }

    const goalChoice = await showGoalList(ctx, goals);
    if (goalChoice.action === "back") return;
    if (goalChoice.action === "refresh") {
      goals = undefined;
      continue;
    }
    const goal = goals.dashboard.goals.find((item) => item.workId === goalChoice.value);
    if (!goal) continue;
    const reference = goals.references.get(goal.workId);
    if (goalChoice.action === "reference") {
      if (reference) await showPkmReference(ctx, goal, reference);
      continue;
    }

    let detail: DashboardGoalDetail | undefined;
    let returnToGoals = false;
    while (!returnToGoals) {
      if (!detail) {
        const loaded = await loadWithUi(
          ctx,
          `Loading ${goal.vault}/${goal.taskId}...`,
          (signal) => reader.loadGoal(goal, viewer, signal),
        );
        if (loaded.kind === "cancelled") {
          returnToGoals = true;
          continue;
        }
        if (loaded.kind === "error") {
          const action = await showError(ctx, loaded.error, true);
          if (action === "refresh") continue;
          returnToGoals = true;
          continue;
        }
        detail = loaded.value;
      }

      const stepChoice = await showStepList(ctx, detail, reference);
      if (stepChoice.action === "back") {
        returnToGoals = true;
        continue;
      }
      if (stepChoice.action === "refresh") {
        detail = undefined;
        continue;
      }
      if (stepChoice.action === "reference") {
        if (reference) await showPkmReference(ctx, goal, reference);
        continue;
      }
      const step = detail.steps.find((item) => item.stepId === stepChoice.value);
      if (!step) continue;
      const history = await loadWithUi(ctx, `Loading ${step.stepId}...`, (signal) =>
        reader.loadStep(goal, step, viewer, signal),
      );
      if (history.kind === "cancelled") continue;
      if (history.kind === "error") {
        const action = await showError(ctx, history.error, true);
        if (action === "refresh") detail = undefined;
        continue;
      }
      const detailChoice = await showStepDetail(ctx, history.value, reference);
      if (detailChoice === "refresh") detail = undefined;
      else if (detailChoice === "reference" && reference) {
        await showPkmReference(ctx, goal, reference);
      }
    }
  }
}

async function loadGoalBrowserSnapshot(
  reader: DashboardReaderLike,
  pkmReader: PkmReferenceReaderLike,
  signal?: AbortSignal,
): Promise<GoalBrowserSnapshot> {
  const dashboard = await reader.loadGoals(signal);
  const loaded = await Promise.all(
    dashboard.goals.map(
      async (goal) =>
        [goal.workId, await pkmReader.read(goal.canonicalPath, goal.taskId, signal)] as const,
    ),
  );
  return { dashboard, references: new Map(loaded) };
}

export function goalTitle(goal: DashboardGoal, reference?: PkmTaskReference): string {
  return reference?.status === "available" && reference.title
    ? safeInline(reference.title)
    : `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}`;
}

export function goalSelectItems(
  snapshot: DashboardSnapshot,
  references: ReadonlyMap<string, PkmTaskReference> = new Map(),
): SelectItem[] {
  return snapshot.goals.map((goal) => ({
    value: goal.workId,
    label: goalTitle(goal, references.get(goal.workId)),
    description: `${safeInline(goal.vault)}/${safeInline(goal.taskId)} · ${formatGoalCounts(goal)} · ${formatRelativeTime(goal.lastActivityAt, snapshot.snapshotAt)}`,
  }));
}

export function stepSelectItems(detail: DashboardGoalDetail): SelectItem[] {
  return detail.steps.map((step) => ({
    value: step.stepId,
    label: safeInline(step.title),
    description: `${formatStepStatus(step)} · ${formatRelativeTime(step.lastActivityAt, detail.snapshotAt)}`,
  }));
}

export function formatStepStatus(step: DashboardStep): string {
  const who = sessionLabel(step.last);
  if (step.state === "done") {
    return `done${step.reviewed ? " · reviewed" : ""} · by ${who}`;
  }
  return `open · last ${who}`;
}

export function sessionLabel(event: DashboardEvent): string {
  if (event.mine) return "this session";
  return event.sessionName ? safeInline(event.sessionName) : shortId(event.sessionId);
}

function shortId(value: string): string {
  const safe = safeInline(value);
  return safe.length <= 15 ? safe : `${safe.slice(0, 8)}…`;
}

export function formatRelativeTime(value: Date, reference: Date): string {
  if (!Number.isFinite(value.getTime()) || !Number.isFinite(reference.getTime())) {
    return "time unavailable";
  }
  const seconds = Math.round((reference.getTime() - value.getTime()) / 1_000);
  const future = seconds < 0;
  const absolute = Math.abs(seconds);
  let amount: number;
  let unit: string;
  if (absolute < 5) return "just now";
  if (absolute < 60) {
    amount = absolute;
    unit = "s";
  } else if (absolute < 3_600) {
    amount = Math.round(absolute / 60);
    unit = "m";
  } else if (absolute < 86_400) {
    amount = Math.round(absolute / 3_600);
    unit = "h";
  } else {
    amount = Math.round(absolute / 86_400);
    unit = "d";
  }
  return future ? `in ${amount}${unit}` : `${amount}${unit} ago`;
}

export function formatExactLocalTime(value: Date): string {
  if (!Number.isFinite(value.getTime())) return "time unavailable";
  return value.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function safeBlock(value: string): string {
  const withoutC1Sequences = value
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0090\u009d][\s\S]*?(?:\u009c|\u0007)/g, "");
  return stripTerminalSequences(withoutC1Sequences)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function safeInline(value: string): string {
  return safeBlock(value).replace(/\s+/g, " ").trim();
}

export function formatGoalPreview(
  goal: DashboardGoal,
  reference: PkmTaskReference | undefined,
  snapshot: DashboardSnapshot,
  theme: Theme,
): string {
  return [
    theme.fg("accent", theme.bold(goalTitle(goal, reference))),
    theme.fg(
      "muted",
      `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}${reference?.status === "available" && reference.project ? ` · project ${safeInline(reference.project)}` : ""}`,
    ),
    "",
    theme.bold("Outcome"),
    theme.fg("text", goal.outcome ? safeBlock(goal.outcome) : "not recorded"),
    "",
    theme.fg(goal.openSteps > 0 ? "accent" : "success", formatGoalCounts(goal)),
    theme.fg(
      "muted",
      `Created ${formatRelativeTime(goal.createdAt, snapshot.snapshotAt)} · last activity ${formatRelativeTime(goal.lastActivityAt, snapshot.snapshotAt)}`,
    ),
    theme.fg(
      reference?.status === "available" ? "success" : "warning",
      safeInline(reference?.notice ?? "PKM reference not loaded"),
    ),
  ].join("\n");
}

export function formatStepPreview(
  step: DashboardStep,
  detail: DashboardGoalDetail,
  theme: Theme,
): string {
  return [
    theme.fg("accent", theme.bold(safeInline(step.title))),
    theme.fg(
      step.state === "done" ? "success" : "accent",
      `${formatStepStatus(step)} · ${step.eventCount} entr${step.eventCount === 1 ? "y" : "ies"} · ${formatRelativeTime(step.lastActivityAt, detail.snapshotAt)}`,
    ),
    "",
    theme.bold("Latest"),
    theme.fg("text", safeBlock(step.last.summary)),
    "",
    theme.bold("Next action"),
    theme.fg(
      step.last.nextAction ? "text" : "muted",
      step.last.nextAction ? safeBlock(step.last.nextAction) : "none recorded",
    ),
  ].join("\n");
}

export function formatEventLine(event: DashboardEvent, reference: Date): string {
  const head = `${event.kind === "done" ? "done" : "note"}${event.kind === "done" && event.reviewed ? " (reviewed)" : ""} · ${sessionLabel(event)} · ${formatRelativeTime(event.recordedAt, reference)}`;
  const lines = [head, `  ${safeInline(event.summary)}`];
  if (event.evidenceRef) lines.push(`  evidence: ${safeInline(event.evidenceRef)}`);
  if (event.nextAction) lines.push(`  next: ${safeInline(event.nextAction)}`);
  return lines.join("\n");
}

export function formatStepDetailText(
  history: DashboardStepHistory,
  reference?: PkmTaskReference,
): string {
  const { step, goal } = history;
  const lines = [
    safeInline(step.title),
    `${formatStepStatus(step)} · ${formatRelativeTime(step.lastActivityAt, history.snapshotAt)}`,
    "",
    "History",
  ];
  if (history.events.length === 0) lines.push("No entries recorded.");
  for (const event of history.events) {
    lines.push(formatEventLine(event, history.snapshotAt), "");
  }
  if (history.omittedEvents > 0) {
    lines.push(
      `${history.omittedEvents} older entr${history.omittedEvents === 1 ? "y" : "ies"} not shown.`,
      "",
    );
  }
  lines.push(
    "Goal",
    `${goalTitle(goal, reference)} · ${safeInline(goal.vault)} / ${safeInline(goal.taskId)}`,
    "",
    "Details",
    `Step ID: ${safeInline(step.stepId)}`,
    `Created: ${formatExactLocalTime(step.createdAt)}`,
    `Task file: ${safeInline(goal.canonicalPath)}`,
    `Snapshot: ${formatExactLocalTime(history.snapshotAt)} (read-only)`,
  );
  return lines.join("\n");
}

function styleStepDetail(text: string, theme: Theme): string {
  const headings = new Set(["History", "Goal", "Details"]);
  let details = false;
  return text
    .split("\n")
    .map((line, index) => {
      if (index === 0) return theme.fg("accent", theme.bold(line));
      if (index === 1) return theme.fg(line.startsWith("done") ? "success" : "accent", line);
      if (headings.has(line)) {
        details = line === "Details";
        return theme.fg("accent", theme.bold(line));
      }
      if (details) return theme.fg("muted", line);
      if (line.startsWith("done")) return theme.fg("success", line);
      if (line.startsWith("note")) return theme.fg("accent", line);
      if (line.startsWith("  evidence:") || line.startsWith("  next:")) {
        return theme.fg("muted", line);
      }
      return theme.fg("text", line);
    })
    .join("\n");
}

export function selectFooterLines(width: number, allowReference: boolean): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const raw =
    safeWidth >= 64
      ? [
          "↑/↓ select · Enter open · PgUp/PgDn preview",
          `${allowReference ? "p PKM · " : ""}r refresh · Esc back`,
        ]
      : ["↑↓/Enter · Pg preview", `${allowReference ? "p PKM · " : ""}r · Esc`];
  return raw.map((line) => truncateToWidth(line, safeWidth, ""));
}

export function createSelectScreen(options: {
  title: string;
  context: string;
  items: SelectItem[];
  navigationLabel?: string;
  previewLabel?: string;
  preview?: (value: string) => string;
  emptyMessage: string;
  disclosure?: string;
  allowReference?: boolean;
  theme: Theme;
  terminalRows?: () => number;
  onDone: (result: SelectResult) => void;
  requestRender: () => void;
}): Component {
  const list = new SelectList(
    options.items,
    Math.max(1, Math.min(options.items.length, 5)),
    getSelectListTheme(),
    { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 68 },
  );
  const previewText = new Text("", 0, 0);
  const previewScroll = new ScrollView(previewText, {
    primary: false,
    overscroll: "contain",
    scrollbar: "hidden",
  });
  const border = new DynamicBorder((text: string) => options.theme.fg("borderAccent", text));
  let selectedValue = list.getSelectedItem()?.value;
  const updatePreview = (value?: string): void => {
    selectedValue = value;
    previewText.setText(value && options.preview ? options.preview(value) : "");
    previewScroll.scrollToStart();
  };
  updatePreview(selectedValue);
  if (options.items.length > 0) {
    list.onSelect = (item) => options.onDone({ action: "select", value: item.value });
    list.onCancel = () => options.onDone({ action: "back" });
    list.onSelectionChange = (item) => updatePreview(item.value);
  }

  return {
    render(width) {
      const safeWidth = Math.max(1, Math.floor(width));
      const panelHeight = options.terminalRows
        ? modalContentRows(options.terminalRows())
        : Number.POSITIVE_INFINITY;
      const decorated = panelHeight >= 12;
      const title = truncateToWidth(
        options.theme.fg("accent", options.theme.bold(safeInline(options.title))),
        safeWidth,
      );
      const context = new Text(options.theme.fg("muted", safeBlock(options.context)), 0, 0)
        .render(safeWidth)
        .slice(0, decorated ? 2 : 0);
      const navigationLabel = decorated
        ? [
            truncateToWidth(
              options.theme.fg(
                "muted",
                options.theme.bold(safeInline(options.navigationLabel ?? "Navigation")),
              ),
              safeWidth,
            ),
          ]
        : [];
      const listLines =
        options.items.length > 0
          ? list.render(safeWidth)
          : new Text(options.theme.fg("warning", safeInline(options.emptyMessage)), 0, 0).render(
              safeWidth,
            );
      const disclosure =
        decorated && options.disclosure
          ? new Text(options.theme.fg("warning", safeBlock(options.disclosure)), 0, 0)
              .render(safeWidth)
              .slice(0, 2)
          : [];
      const footer = selectFooterLines(safeWidth, options.allowReference ?? false).map((line) =>
        options.theme.fg("customMessageText", line),
      );
      const chrome = [
        ...(decorated ? border.render(safeWidth) : []),
        title,
        ...context,
        ...navigationLabel,
        ...listLines,
      ];
      const tail = [...disclosure, ...footer, ...(decorated ? border.render(safeWidth) : [])];
      const availablePreviewRows = Math.max(
        0,
        Number.isFinite(panelHeight)
          ? panelHeight - chrome.length - tail.length
          : previewScroll.render(safeWidth).length + 2,
      );
      const previewChrome =
        decorated && selectedValue && options.preview && availablePreviewRows >= 3
          ? [
              options.theme.fg("borderMuted", "─".repeat(safeWidth)),
              truncateToWidth(
                options.theme.fg(
                  "accent",
                  options.theme.bold(safeInline(options.previewLabel ?? "Selected")),
                ),
                safeWidth,
              ),
            ]
          : [];
      const previewHeight = Math.max(0, availablePreviewRows - previewChrome.length);
      const previewContent = previewScroll.render(safeWidth);
      previewScroll.updateLayout(previewContent.length, previewHeight, options.requestRender);
      const preview =
        previewHeight > 0
          ? previewContent.slice(previewScroll.scrollTop, previewScroll.scrollTop + previewHeight)
          : [];
      while (preview.length < previewHeight) preview.push("");
      return [...chrome, ...previewChrome, ...preview, ...tail];
    },
    invalidate() {
      list.invalidate();
      previewText.invalidate();
      previewScroll.invalidate();
      border.invalidate();
      updatePreview(selectedValue);
    },
    handleInput(data) {
      if (data === "r") options.onDone({ action: "refresh" });
      else if (data === "p" && options.allowReference && selectedValue) {
        options.onDone({ action: "reference", value: selectedValue });
      } else if (matchesKey(data, Key.pageUp)) {
        previewScroll.scrollBy(-Math.max(1, previewScroll.viewportHeight - 1));
      } else if (matchesKey(data, Key.pageDown)) {
        previewScroll.scrollBy(Math.max(1, previewScroll.viewportHeight - 1));
      } else if (options.items.length > 0) {
        list.handleInput(data);
      } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        options.onDone({ action: "back" });
      }
      options.requestRender();
    },
  };
}

export const SPOOL_MODAL_HEIGHT_RATIO = 0.85;
export const SPOOL_MODAL_VERTICAL_PADDING = 2;
export const MAX_DETAIL_PANEL_ROWS = 27;

export interface ScrollScreen extends Component {
  readonly scrollTop: number;
  readonly viewportHeight: number;
}

export function modalContentRows(terminalRows: number): number {
  const safeRows = Number.isFinite(terminalRows) ? Math.max(0, Math.floor(terminalRows)) : 0;
  return Math.max(
    3,
    Math.floor(safeRows * SPOOL_MODAL_HEIGHT_RATIO) - SPOOL_MODAL_VERTICAL_PADDING,
  );
}

export function detailPanelRows(terminalRows: number): number {
  return Math.min(MAX_DETAIL_PANEL_ROWS, modalContentRows(terminalRows));
}

/** A bordered, scrollable text panel used for step history and PKM reference. */
export function createScrollScreen(options: {
  heading: string;
  text: () => string;
  extraHints?: string;
  theme: Theme;
  terminalRows: () => number;
  onDone: (result: "back" | "refresh" | "reference") => void;
  requestRender: () => void;
  allowReference?: boolean;
}): ScrollScreen {
  const body = new Text("", 1, 0);
  const updateBody = (): void => body.setText(options.text());
  updateBody();
  const scroll = new ScrollView(body, {
    primary: true,
    overscroll: "contain",
    scrollbar: "hidden",
  });
  const border = new DynamicBorder((text: string) => options.theme.fg("accent", text));
  return {
    get scrollTop() {
      return scroll.scrollTop;
    },
    get viewportHeight() {
      return scroll.viewportHeight;
    },
    render(width) {
      const safeWidth = Math.max(1, Math.floor(width));
      const panelHeight = detailPanelRows(options.terminalRows());
      const decorated = panelHeight >= 6;
      const heading = truncateToWidth(
        options.theme.fg("accent", options.theme.bold(options.heading)),
        safeWidth,
      );
      const header = decorated ? [...border.render(safeWidth), heading] : [heading];
      const footerHeight = decorated ? 2 : 1;
      const bodyHeight = Math.max(1, panelHeight - header.length - footerHeight);
      const content = scroll.render(safeWidth);
      scroll.updateLayout(content.length, bodyHeight, options.requestRender);
      const start = scroll.scrollTop;
      const visible = content.slice(start, start + bodyHeight);
      while (visible.length < bodyHeight) visible.push("");
      const end = Math.min(start + bodyHeight, content.length);
      const status = truncateToWidth(
        options.theme.fg(
          "dim",
          `Rows ${content.length === 0 ? 0 : start + 1}–${end}/${content.length} · ↑↓ scroll${options.extraHints ? ` · ${options.extraHints}` : ""} · ${keyHint("tui.select.cancel", "back")}`,
        ),
        safeWidth,
      );
      return decorated
        ? [...header, ...visible, status, ...border.render(safeWidth)]
        : [...header, ...visible, status];
    },
    invalidate() {
      body.invalidate();
      scroll.invalidate();
      border.invalidate();
      updateBody();
    },
    handleInput(data) {
      if (data === "r") options.onDone("refresh");
      else if (data === "p" && options.allowReference) options.onDone("reference");
      else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        options.onDone("back");
      } else if (matchesKey(data, Key.home)) scroll.scrollToStart();
      else if (matchesKey(data, Key.end)) scroll.scrollToEnd();
      else if (matchesKey(data, Key.pageUp)) {
        scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
      } else if (matchesKey(data, Key.pageDown)) {
        scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
      } else if (matchesKey(data, Key.up)) scroll.scrollBy(-1);
      else if (matchesKey(data, Key.down)) scroll.scrollBy(1);
      options.requestRender();
    },
  };
}

export function createStepDetailScreen(options: {
  history: DashboardStepHistory;
  reference?: PkmTaskReference;
  theme: Theme;
  terminalRows: () => number;
  onDone: (result: "back" | "refresh" | "reference") => void;
  requestRender: () => void;
}): ScrollScreen {
  return createScrollScreen({
    heading: "Step",
    text: () =>
      styleStepDetail(formatStepDetailText(options.history, options.reference), options.theme),
    extraHints: "p PKM · r refresh",
    allowReference: true,
    theme: options.theme,
    terminalRows: options.terminalRows,
    onDone: options.onDone,
    requestRender: options.requestRender,
  });
}

export function spoolOverlayOptions(terminalColumns: number): OverlayOptions {
  const available = Math.max(1, Math.floor(terminalColumns) - 2);
  const preferred = Math.floor(terminalColumns * 0.9);
  const width = Math.min(112, available, Math.max(40, preferred));
  return {
    anchor: "center",
    width,
    minWidth: Math.min(40, available),
    maxHeight: "85%",
    margin: 1,
  };
}

export function renderModalSurfaceLine(line: string, width: number, theme: Theme): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const padding = safeWidth >= 5 ? 2 : 0;
  const innerWidth = Math.max(1, safeWidth - padding * 2);
  const clipped = truncateToWidth(line, innerWidth, "");
  const background = theme.getBgAnsi("customMessageBg");
  const withContinuousBackground = clipped.replace(
    /\u001b\[([0-9;]*)m/g,
    (sequence, parameters: string) => {
      const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
      return codes.includes(0) || codes.includes(49) ? `${sequence}${background}` : sequence;
    },
  );
  const right = " ".repeat(Math.max(0, innerWidth - visibleWidth(withContinuousBackground)));
  return theme.bg(
    "customMessageBg",
    `${" ".repeat(padding)}${withContinuousBackground}${right}${" ".repeat(padding)}`,
  );
}

function modalSurface(
  component: Component & { dispose?(): void },
  theme: Theme,
): Component & { dispose?(): void } {
  return {
    render(width) {
      const safeWidth = Math.max(1, Math.floor(width));
      const padding = safeWidth >= 5 ? 2 : 0;
      const innerWidth = Math.max(1, safeWidth - padding * 2);
      const blank = theme.bg("customMessageBg", " ".repeat(safeWidth));
      const lines = component
        .render(innerWidth)
        .map((line) => renderModalSurfaceLine(line, safeWidth, theme));
      return [blank, ...lines, blank];
    },
    invalidate() {
      component.invalidate();
    },
    handleInput(data) {
      component.handleInput?.(data);
    },
    dispose() {
      component.dispose?.();
    },
  };
}

async function showModal<T>(
  ctx: ExtensionCommandContext,
  factory: (
    tui: TUI,
    theme: Theme,
    done: (result: T) => void,
  ) => Component & { dispose?(): void },
): Promise<T> {
  let liveTui: TUI | undefined;
  return await ctx.ui.custom<T>(
    (tui, theme, _keybindings, done) => {
      liveTui = tui;
      return modalSurface(factory(tui, theme, done), theme);
    },
    {
      overlay: true,
      overlayOptions: () => spoolOverlayOptions(liveTui?.terminal?.columns ?? 120),
    },
  );
}

async function showGoalList(
  ctx: ExtensionCommandContext,
  browser: GoalBrowserSnapshot,
): Promise<SelectResult> {
  const snapshot = browser.dashboard;
  return await showModal(ctx, (tui, theme, done) =>
    createSelectScreen({
      title: "Spool work log",
      context: `${snapshot.totalGoals} goal(s) · snapshot ${formatRelativeTime(snapshot.snapshotAt, new Date())}`,
      items: goalSelectItems(snapshot, browser.references),
      navigationLabel: "Goals",
      previewLabel: "Selected goal",
      preview: (value) => {
        const goal = snapshot.goals.find((item) => item.workId === value);
        return goal
          ? formatGoalPreview(goal, browser.references.get(value), snapshot, theme)
          : "";
      },
      emptyMessage: "No goals recorded yet.",
      disclosure:
        snapshot.omittedGoals > 0
          ? `${snapshot.omittedGoals} goal(s) beyond the ${snapshot.goals.length}-goal window are not shown.`
          : undefined,
      allowReference: true,
      theme,
      terminalRows: () => tui.terminal.rows,
      onDone: done,
      requestRender: () => tui.requestRender(),
    }),
  );
}

async function showStepList(
  ctx: ExtensionCommandContext,
  detail: DashboardGoalDetail,
  reference?: PkmTaskReference,
): Promise<SelectResult> {
  return await showModal(ctx, (tui, theme, done) =>
    createSelectScreen({
      title: goalTitle(detail.goal, reference),
      context: `${safeInline(detail.goal.vault)} / ${safeInline(detail.goal.taskId)} · ${formatGoalCounts(detail.goal)} · snapshot ${formatRelativeTime(detail.snapshotAt, new Date())}`,
      items: stepSelectItems(detail),
      navigationLabel: "Steps",
      previewLabel: "Selected step",
      preview: (value) => {
        const step = detail.steps.find((item) => item.stepId === value);
        return step ? formatStepPreview(step, detail, theme) : "";
      },
      emptyMessage: "No steps recorded for this goal.",
      disclosure:
        detail.omittedSteps > 0
          ? `${detail.omittedSteps} step(s) beyond the ${detail.steps.length}-step window are not shown.`
          : undefined,
      allowReference: true,
      theme,
      terminalRows: () => tui.terminal.rows,
      onDone: done,
      requestRender: () => tui.requestRender(),
    }),
  );
}

async function showStepDetail(
  ctx: ExtensionCommandContext,
  history: DashboardStepHistory,
  reference?: PkmTaskReference,
): Promise<"back" | "refresh" | "reference"> {
  return await showModal(ctx, (tui, theme, done) =>
    createStepDetailScreen({
      history,
      reference,
      theme,
      terminalRows: () => tui.terminal.rows,
      onDone: done,
      requestRender: () => tui.requestRender(),
    }),
  );
}

export function formatPkmReferenceText(goal: DashboardGoal, reference: PkmTaskReference): string {
  const lines = [
    goalTitle(goal, reference),
    `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}${reference.status === "available" && reference.project ? ` · project ${safeInline(reference.project)}` : ""}`,
    "",
    "Reference status",
    safeInline(reference.notice),
    "",
  ];
  if (reference.status === "available" && reference.goalText) {
    lines.push("PKM goal", safeBlock(reference.goalText), "");
  }
  lines.push(
    "Recorded outcome",
    goal.outcome ? safeBlock(goal.outcome) : "not recorded",
    "",
    "Details",
    `Task file: ${safeInline(reference.canonicalPath)}`,
    `Expected task ID: ${safeInline(reference.expectedTaskId)}`,
    `File task ID: ${reference.fileTaskId ? safeInline(reference.fileTaskId) : "not available"}`,
  );
  return lines.join("\n");
}

export function createPkmReferenceScreen(options: {
  goal: DashboardGoal;
  reference: PkmTaskReference;
  theme: Theme;
  terminalRows: () => number;
  onDone: () => void;
  requestRender: () => void;
}): ScrollScreen {
  const headings = new Set(["Reference status", "PKM goal", "Recorded outcome", "Details"]);
  return createScrollScreen({
    heading: "PKM reference",
    text: () =>
      formatPkmReferenceText(options.goal, options.reference)
        .split("\n")
        .map((line, index) => {
          if (index === 0) return options.theme.fg("accent", options.theme.bold(line));
          if (headings.has(line)) return options.theme.fg("accent", options.theme.bold(line));
          if (line === safeInline(options.reference.notice)) {
            return options.theme.fg(
              options.reference.status === "available" ? "success" : "warning",
              line,
            );
          }
          if (/^(Task file|Expected task ID|File task ID):/.test(line)) {
            return options.theme.fg("muted", line);
          }
          return options.theme.fg("text", line);
        })
        .join("\n"),
    theme: options.theme,
    terminalRows: options.terminalRows,
    onDone: () => options.onDone(),
    requestRender: options.requestRender,
  });
}

async function showPkmReference(
  ctx: ExtensionCommandContext,
  goal: DashboardGoal,
  reference: PkmTaskReference,
): Promise<void> {
  await showModal(ctx, (tui, theme, done) =>
    createPkmReferenceScreen({
      goal,
      reference,
      theme,
      terminalRows: () => tui.terminal.rows,
      onDone: () => done(undefined),
      requestRender: () => tui.requestRender(),
    }),
  );
}

export function createErrorScreen(options: {
  error: Error;
  backToGoals: boolean;
  theme: Theme;
  onDone: (result: "refresh" | "back") => void;
  requestRender: () => void;
}): Component {
  const message = safeInline(spoolUserFacingError(options.error).message);
  const bounded = message.length <= 1_000 ? message : `${message.slice(0, 1_000)}… [truncated]`;
  return {
    render(width) {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => options.theme.fg("error", text)));
      container.addChild(
        new Text(options.theme.fg("error", options.theme.bold("Spool unavailable")), 1, 0),
      );
      container.addChild(new Text(options.theme.fg("text", bounded), 1, 1));
      container.addChild(
        new Text(
          options.theme.fg(
            "dim",
            `r retry · ${keyHint("tui.select.cancel", options.backToGoals ? "back to goals" : "close")}`,
          ),
          1,
          0,
        ),
      );
      container.addChild(new DynamicBorder((text: string) => options.theme.fg("error", text)));
      return container.render(width);
    },
    invalidate() {},
    handleInput: (data) => {
      if (data === "r") options.onDone("refresh");
      else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        options.onDone("back");
      }
      options.requestRender();
    },
  };
}

async function showError(
  ctx: ExtensionCommandContext,
  error: Error,
  backToGoals: boolean,
): Promise<"refresh" | "back"> {
  return await showModal(ctx, (tui, theme, done) =>
    createErrorScreen({
      error,
      backToGoals,
      theme,
      onDone: done,
      requestRender: () => tui.requestRender(),
    }),
  );
}

async function loadWithUi<T>(
  ctx: ExtensionCommandContext,
  message: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<LoadResult<T>> {
  return await showModal(ctx, (tui, theme, done) => {
    const loader = new BorderedLoader(tui, theme, message);
    let disposed = false;
    const finish = (result: LoadResult<T>): void => {
      if (disposed) return;
      disposed = true;
      done(result);
    };
    loader.onAbort = () => finish({ kind: "cancelled" });
    operation(loader.signal).then(
      (value) => finish({ kind: "loaded", value }),
      (error: unknown) => {
        if (error instanceof DashboardCancelledError || loader.signal.aborted) {
          finish({ kind: "cancelled" });
          return;
        }
        finish({
          kind: "error",
          error: error instanceof Error ? error : new Error("Unknown dashboard error"),
        });
      },
    );
    return loader;
  });
}
