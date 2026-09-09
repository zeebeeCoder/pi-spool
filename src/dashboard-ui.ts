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
  formatDashboardCounts,
  nextDashboardSort,
  type DashboardGoal,
  type DashboardGoalDetail,
  type DashboardGoalSnapshot,
  type DashboardSort,
  type DashboardStep,
} from "./dashboard-data.ts";
import {
  PkmReferenceReader,
  type PkmReferenceReaderLike,
  type PkmTaskReference,
} from "./pkm-reference.ts";
import {
  spoolUserFacingError,
  type RuntimeIdentity,
} from "./spool-service.ts";

export interface DashboardReaderLike {
  readonly queueName: string;
  loadGoals(
    sort?: DashboardSort,
    signal?: AbortSignal,
  ): Promise<DashboardGoalSnapshot>;
  loadGoal(
    goal: DashboardGoal,
    viewer: RuntimeIdentity,
    sort?: DashboardSort,
    signal?: AbortSignal,
  ): Promise<DashboardGoalDetail>;
  close(): Promise<void>;
}

type SelectResult =
  | { action: "select"; value: string }
  | { action: "reference"; value: string }
  | { action: "refresh" }
  | { action: "sort" }
  | { action: "back" };

interface GoalBrowserSnapshot {
  dashboard: DashboardGoalSnapshot;
  references: ReadonlyMap<string, PkmTaskReference>;
  cache: PkmSnapshotCache;
}

type LoadResult<T> =
  | { kind: "loaded"; value: T }
  | { kind: "cancelled" }
  | { kind: "error"; error: Error };

class PkmSnapshotCache {
  private readonly entries = new Map<string, Promise<PkmTaskReference>>();
  private readonly reader: PkmReferenceReaderLike;

  constructor(reader: PkmReferenceReaderLike) {
    this.reader = reader;
  }

  load(
    canonicalPath: string,
    expectedTaskId: string,
    signal?: AbortSignal,
  ): Promise<PkmTaskReference> {
    const key = JSON.stringify([canonicalPath, expectedTaskId]);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const pending = this.reader.read(canonicalPath, expectedTaskId, signal);
    this.entries.set(key, pending);
    return pending;
  }
}

export async function runSpoolDashboard(
  ctx: ExtensionCommandContext,
  reader: DashboardReaderLike,
  viewer: RuntimeIdentity,
  pkmReader: PkmReferenceReaderLike = new PkmReferenceReader(),
): Promise<void> {
  let goalSort: DashboardSort = "attention";
  let goals: GoalBrowserSnapshot | undefined;
  while (true) {
    if (!goals) {
      const loaded = await loadWithUi(
        ctx,
        "Loading read-only Spool goals and PKM attribution...",
        (signal) => loadGoalBrowserSnapshot(reader, pkmReader, goalSort, signal),
      );
      if (loaded.kind === "cancelled") return;
      if (loaded.kind === "error") {
        const action = await showError(
          ctx,
          reader.queueName,
          loaded.error,
          false,
        );
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
    if (goalChoice.action === "sort") {
      goalSort = nextDashboardSort(goalSort);
      goals = undefined;
      continue;
    }
    const goal = goals.dashboard.goals.find(
      (item) => item.key === goalChoice.value,
    );
    if (!goal) continue;
    if (goalChoice.action === "reference") {
      const reference = goals.references.get(goal.key);
      if (reference) await showPkmReference(ctx, goal, reference);
      continue;
    }

    let stepSort: DashboardSort = "attention";
    let detail: DashboardGoalDetail | undefined;
    let latestReference = goals.references.get(goal.key);
    let pkmCache = goals.cache;
    let returnToGoals = false;
    while (!returnToGoals) {
      if (!detail) {
        const loaded = await loadWithUi(
          ctx,
          `Loading ${goal.vault}/${goal.taskId} workflow...`,
          async (signal) => {
            const dashboard = await reader.loadGoal(
              goal,
              viewer,
              stepSort,
              signal,
            );
            const reference = await pkmCache.load(
              dashboard.goal.latestCanonicalPath,
              dashboard.goal.taskId,
              signal,
            );
            return { dashboard, reference };
          },
        );
        if (loaded.kind === "cancelled") {
          returnToGoals = true;
          continue;
        }
        if (loaded.kind === "error") {
          const action = await showError(
            ctx,
            reader.queueName,
            loaded.error,
            true,
          );
          if (action === "refresh") continue;
          returnToGoals = true;
          continue;
        }
        detail = loaded.value.dashboard;
        latestReference = loaded.value.reference;
      }

      const stepChoice = await showStepList(ctx, detail, latestReference);
      if (stepChoice.action === "back") {
        returnToGoals = true;
        continue;
      }
      if (stepChoice.action === "refresh") {
        pkmCache = new PkmSnapshotCache(pkmReader);
        detail = undefined;
        continue;
      }
      if (stepChoice.action === "sort") {
        stepSort = nextDashboardSort(stepSort);
        pkmCache = new PkmSnapshotCache(pkmReader);
        detail = undefined;
        continue;
      }
      const step = detail.steps.find(
        (item) => dashboardStepKey(item) === stepChoice.value,
      );
      if (!step) continue;
      const loadedReference = await loadWithUi(
        ctx,
        "Loading read-only PKM attribution...",
        (signal) =>
          pkmCache.load(step.work.canonicalPath, detail!.goal.taskId, signal),
      );
      if (loadedReference.kind === "cancelled") continue;
      const stepReference =
        loadedReference.kind === "loaded"
          ? loadedReference.value
          : latestReference;
      if (stepChoice.action === "reference") {
        if (stepReference) await showPkmReference(ctx, detail.goal, stepReference);
        continue;
      }
      const detailChoice = await showStepDetail(
        ctx,
        detail,
        step,
        stepReference,
      );
      if (detailChoice === "refresh") {
        pkmCache = new PkmSnapshotCache(pkmReader);
        detail = undefined;
      } else if (detailChoice === "reference" && stepReference) {
        await showPkmReference(ctx, detail.goal, stepReference);
      }
    }
  }
}

async function loadGoalBrowserSnapshot(
  reader: DashboardReaderLike,
  pkmReader: PkmReferenceReaderLike,
  sort: DashboardSort,
  signal?: AbortSignal,
): Promise<GoalBrowserSnapshot> {
  const dashboard = await reader.loadGoals(sort, signal);
  const cache = new PkmSnapshotCache(pkmReader);
  const loaded = await Promise.all(
    dashboard.goals.map(async (goal) => [
      goal.key,
      await cache.load(goal.latestCanonicalPath, goal.taskId, signal),
    ] as const),
  );
  return { dashboard, references: new Map(loaded), cache };
}

export function goalSelectItems(
  snapshot: DashboardGoalSnapshot,
  references: ReadonlyMap<string, PkmTaskReference> = new Map(),
): SelectItem[] {
  return snapshot.goals.map((goal) => {
    const reference = references.get(goal.key);
    const label =
      reference?.status === "available" && reference.title
        ? safeInline(reference.title)
        : `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}`;
    return {
      value: goal.key,
      label,
      description: `${safeInline(goal.vault)}/${safeInline(goal.taskId)} · ${formatDashboardCounts(goal.counts)} · recorded Spool activity ${formatRelativeTime(goal.lastActivityAt, snapshot.snapshotAt)}`,
    };
  });
}

export function stepSelectItems(detail: DashboardGoalDetail): SelectItem[] {
  const showScope = detail.goal.workCount > 1;
  return detail.steps.map((step) => ({
    value: dashboardStepKey(step),
    label: safeInline(step.title),
    description: `${formatStepStatus(step)} · recorded Spool activity ${formatRelativeTime(step.lastActivityAt, detail.snapshotAt)}${showScope ? ` · scope ${shortId(step.work.workId)}` : ""}`,
  }));
}

export function dashboardStepKey(step: DashboardStep): string {
  return JSON.stringify([step.work.workId, step.stepId]);
}

function humanizeState(state: string): string {
  return safeInline(state).replaceAll("_", " ").replaceAll("-", " ");
}

function shortId(value: string): string {
  const safe = safeInline(value);
  return safe.length <= 15 ? safe : `${safe.slice(0, 7)}…${safe.slice(-6)}`;
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
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
      "",
    );
}

export function safeInline(value: string): string {
  return safeBlock(value).replace(/\s+/g, " ").trim();
}

function formatPkmAttribution(
  detail: DashboardGoalDetail,
  reference?: PkmTaskReference,
): string {
  if (reference?.status === "available") {
    return `${reference.title ? safeInline(reference.title) : `${safeInline(detail.goal.vault)} / ${safeInline(detail.goal.taskId)}`}${reference.project ? ` · project ${safeInline(reference.project)}` : ""} · verified from the recorded canonical task (p opens reference)`;
  }
  const notice = reference?.notice ?? "PKM reference was not loaded";
  return `${safeInline(notice)}. Fallback: ${safeInline(detail.goal.vault)} / ${safeInline(detail.goal.taskId)}. Recorded workflow purpose: ${safeInline(detail.goal.latestOutcome)}`;
}

export function formatGoalPreview(
  goal: DashboardGoal,
  reference: PkmTaskReference | undefined,
  snapshot: DashboardGoalSnapshot,
  theme: Theme,
): string {
  const title =
    reference?.status === "available" && reference.title
      ? safeInline(reference.title)
      : `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}`;
  return [
    theme.fg("accent", theme.bold(title)),
    theme.fg(
      "muted",
      `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}${reference?.status === "available" && reference.project ? ` · project ${safeInline(reference.project)}` : ""}${reference?.status === "available" ? " · PKM title from latest recorded work scope" : ""}`,
    ),
    "",
    theme.bold("Recorded workflow purpose"),
    theme.fg("text", safeBlock(goal.latestOutcome)),
    "",
    theme.bold("Tracked execution state"),    stateStyledText(
      formatDashboardCounts(goal.counts),
      goal.counts.running > 0 || goal.counts.reportedInProgress > 0
        ? "running"
        : goal.counts.ready > 0
          ? "ready"
          : "execution_completed",
      theme,
    ),
    theme.fg(
      "muted",
      `Created ${formatRelativeTime(goal.createdAt, snapshot.snapshotAt)} · last recorded Spool activity ${formatRelativeTime(goal.lastActivityAt, snapshot.snapshotAt)} · snapshot ${formatRelativeTime(snapshot.snapshotAt, new Date())} · manual refresh only`,
    ),
    theme.fg(
      "muted",
      "Activity outside Spool is not recorded or inferred and remains unknown.",
    ),
    theme.fg(
      reference?.status === "available" ? "success" : "warning",
      safeInline(reference?.notice ?? "PKM attribution unavailable"),
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
    stateStyledText(
      `${formatStepStatus(step)} · created ${formatRelativeTime(step.createdAt, detail.snapshotAt)} · last recorded Spool activity ${formatRelativeTime(step.lastActivityAt, detail.snapshotAt)}`,
      step.latestAttempt?.leaseStatus === "expired" ? "expired" : step.stepState,
      theme,
    ),
    "",
    theme.bold("What this contributes"),
    theme.fg("text", safeBlock(step.contribution)),
    "",
    theme.bold("Useful next action"),
    theme.fg(
      step.latestAttempt?.nextAction ? "text" : "muted",
      step.report?.nextAction
        ? safeBlock(step.report.nextAction)
        : step.latestAttempt?.nextAction
          ? safeBlock(step.latestAttempt.nextAction)
          : step.report
            ? "No next action was included in the attributed report."
            : step.latestAttempt
              ? "No next action recorded."
              : "No tracked attempt in Spool; activity outside Spool is unknown.",
    ),
  ].join("\n");
}

function stateStyledText(
  text: string,
  state: string,
  theme: Theme,
): string {
  if (state === "expired") return theme.fg("error", text);
  if (state === "ready") return theme.fg("warning", text);
  if (state === "execution_completed" || state === "reported_finished_untracked") {
    return theme.fg("success", text);
  }
  return theme.fg("accent", text);
}

function styleStepDetail(
  text: string,
  step: DashboardStep,
  theme: Theme,
): string {
  const headings = new Set([
    "What this contributes",
    "Completion criteria",
    "Activity",
    "Latest checkpoint",
    "Attributed report",
    "Execution record",
    "PKM attribution",
    "Technical details",
  ]);
  let technical = false;
  return text
    .split("\n")
    .map((line, index) => {
      if (index === 0) return theme.fg("accent", theme.bold(line));
      if (index === 1) {
        return stateStyledText(
          line,
          step.latestAttempt?.leaseStatus === "expired"
            ? "expired"
            : step.stepState,
          theme,
        );
      }
      if (headings.has(line)) {
        if (line === "Technical details") technical = true;
        return theme.fg("accent", theme.bold(line));
      }
      if (line.startsWith("Execution is complete.")) {
        return theme.fg("success", line);
      }
      if (line.includes("lease expired") || line.includes("not current ownership")) {
        return theme.fg("error", line);
      }
      if (line.startsWith("Review / acceptance")) {
        return theme.fg("warning", line);
      }
      if (
        technical ||
        line.startsWith("Last recorded Spool activity:") ||
        line.startsWith("Activity outside Spool") ||
        line.startsWith("Recorded ")
      ) {
        return theme.fg("muted", line);
      }
      return theme.fg("text", line);
    })
    .join("\n");
}

export function formatStepStatus(step: DashboardStep): string {
  if (step.report) {
    const reporter = step.report.reporterPiSessionName ?? shortId(step.report.reporterPiSessionId);
    return `reported ${humanizeState(step.report.disposition)} · untracked execution · reporter ${reporter}`;
  }
  const state = `${humanizeState(step.stepState)} in Spool`;
  const attempt = step.latestAttempt;
  if (!attempt) return `${state} · no tracked attempt`;
  const owner = attempt.piSessionName ?? shortId(attempt.piSessionId);
  if (attempt.attemptState === "active" && attempt.leaseStatus === "expired") {
    return `${state} · expired lease · last owner ${owner}`;
  }
  if (attempt.isCurrentRuntimeOwner) return `${state} · owned here`;
  if (attempt.attemptState === "active" && attempt.leaseStatus === "valid") {
    return `${state} · owner ${owner}`;
  }
  return `${state} · last owner ${owner}`;
}

export function formatStepDetailText(
  detail: DashboardGoalDetail,
  step: DashboardStep,
  options: {
    reference?: PkmTaskReference;
    technical?: boolean;
  } = {},
): string {
  const attempt = step.latestAttempt;
  const checkpoint = step.checkpoint;
  const completion = step.completion;
  const ownership = step.report
    ? `Attributed report from ${safeInline(step.report.reporterPiSessionName ?? step.report.reporterPiSessionId)}; execution is untracked and no lease ownership is claimed.`
    : !attempt
      ? "No tracked attempt is recorded in Spool. Activity outside Spool is not recorded or inferred and remains unknown."
    : attempt.isCurrentRuntimeOwner
      ? `Owned by this Pi runtime (${safeInline(attempt.piSessionName ?? attempt.piSessionId)}).`
      : attempt.attemptState === "active" && attempt.leaseStatus === "expired"
        ? `The latest attempt from ${safeInline(attempt.piSessionName ?? attempt.piSessionId)} is recorded active, but its lease expired; it is not current ownership.`
        : attempt.attemptState === "active" && attempt.leaseStatus === "valid"
          ? `Owned by ${safeInline(attempt.piSessionName ?? attempt.piSessionId)} with a valid lease.`
          : `Last worked by ${safeInline(attempt.piSessionName ?? attempt.piSessionId)}; no current lease ownership is recorded.`;
  const lines = [
    safeInline(step.title),
    `${formatStepStatus(step)} · last recorded Spool activity ${formatRelativeTime(step.lastActivityAt, detail.snapshotAt)}`,
    "",
    "What this contributes",
    safeBlock(step.contribution),
    "",
    "Completion criteria",
    safeBlock(step.criteria),
    "",
    "Activity",
    ownership,
  ];
  if (attempt) {
    lines.push(
      `Latest transition: ${humanizeState(attempt.lastTransition)}${attempt.lastSummary ? ` — ${safeInline(attempt.lastSummary)}` : ""}`,
      `Latest recorded attempt next action: ${attempt.nextAction ? safeInline(attempt.nextAction) : "none recorded"}`,
      `Last recorded Spool activity: ${formatRelativeTime(attempt.lastActivityAt, detail.snapshotAt)}. This may include a lease heartbeat; it is not time spent.`,
      "Activity outside Spool is not recorded or inferred and remains unknown.",
    );
  }
  if (step.report) {
    lines.push(
      "",
      "Attributed report",
      `${humanizeState(step.report.disposition)} · untracked execution`,
      safeBlock(step.report.summary),
      `Evidence: ${safeInline(step.report.evidenceRef)}`,
      `Reported ${formatRelativeTime(step.report.reportedAt, detail.snapshotAt)} by ${safeInline(step.report.reporterPiSessionName ?? step.report.reporterPiSessionId)}`,
      `Next action: ${step.report.nextAction ? safeInline(step.report.nextAction) : "none reported"}`,
      "Reporter-attributed status; not lease ownership, verified truth, or acceptance.",
    );
  }
  if (checkpoint) {
    lines.push(
      "",
      "Latest checkpoint",
      safeInline(checkpoint.name),
      `Evidence: ${checkpoint.evidenceRef ? safeInline(checkpoint.evidenceRef) : "none recorded"}`,
      checkpoint.recordedAt
        ? `Recorded ${formatRelativeTime(new Date(checkpoint.recordedAt), detail.snapshotAt)}`
        : "Checkpoint time not recorded",
    );
  }
  if (completion) {
    lines.push(
      "",
      "Execution record",
      completion.summary ? safeBlock(completion.summary) : "Execution summary not recorded.",
      `Result reference: ${completion.resultRef ? safeInline(completion.resultRef) : "none recorded"}`,
      "Execution is complete. Review / acceptance is not recorded.",
    );
  } else {
    lines.push("", "Review / acceptance is not recorded.");
  }
  lines.push("", "PKM attribution", formatPkmAttribution(detail, options.reference));
  if (detail.omittedSteps > 0) {
    lines.push(
      "",
      `${detail.omittedSteps} of ${detail.totalSteps} step(s) are omitted from this bounded view.`,
    );
  }
  if (detail.goal.omittedScopes > 0) {
    lines.push(
      `${detail.goal.omittedScopes} work scope(s) are omitted; this step retains its exact work identity.`,
    );
  }
  if (options.technical) {
    lines.push(
      "",
      "Technical details",
      `Queue: ${safeInline(detail.queueName)}`,
      `Snapshot: ${formatExactLocalTime(detail.snapshotAt)} (read-only)`,
      `Vault / task: ${safeInline(detail.goal.vault)} / ${safeInline(detail.goal.taskId)}`,
      `Step ID: ${safeInline(step.stepId)}`,
      `Work ID: ${safeInline(step.work.workId)}`,
      `Absurd task state: ${step.taskState ? safeInline(step.taskState) : "not available"}`,
      `Step created: ${formatExactLocalTime(step.createdAt)}`,
      `Last recorded Spool activity: ${formatExactLocalTime(step.lastActivityAt)}`,
      `Recorded outcome: ${safeBlock(step.work.outcome)}`,
      `Canonical path: ${safeInline(step.work.canonicalPath)}`,
    );
    if (attempt) {
      lines.push(
        `Attempt: ${attempt.attempt} · ${safeInline(attempt.attemptState)}`,
        `Session ID: ${safeInline(attempt.piSessionId)}`,
        `Claimed: ${formatExactLocalTime(attempt.claimedAt)}`,
        `Attempt activity: ${formatExactLocalTime(attempt.lastActivityAt)}`,
        `Lease: ${safeInline(attempt.leaseStatus)} · expires ${formatExactLocalTime(attempt.leaseExpiresAt)}`,
      );
    }
  }
  return lines.join("\n");
}

export function selectFooterLines(
  width: number,
  sort: DashboardSort | undefined,
  allowReference: boolean,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const raw =
    safeWidth >= 64
      ? [
          "↑/↓ select · Enter open · PgUp/PgDn preview",
          `${sort ? `s sort:${sort} · ` : ""}${allowReference ? "p PKM · " : ""}r refresh · Esc back`,
        ]
      : safeWidth >= 32
        ? [
            "↑↓/Enter select · Pg preview",
            `${sort ? "s sort · " : ""}${allowReference ? "p PKM · " : ""}r reload · Esc back`,
          ]
        : [
            "↑↓/Enter · Pg preview",
            `${sort ? "s sort · " : ""}${allowReference ? "p PKM · " : ""}r · Esc`,
          ];
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
  disclosure: string;
  sort?: DashboardSort;
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
  const border = new DynamicBorder((text: string) =>
    options.theme.fg("borderAccent", text),
  );
  let selectedValue = list.getSelectedItem()?.value;
  const updatePreview = (value?: string): void => {
    selectedValue = value;
    previewText.setText(value && options.preview ? options.preview(value) : "");
    previewScroll.scrollToStart();
  };
  updatePreview(selectedValue);
  if (options.items.length > 0) {
    list.onSelect = (item) =>
      options.onDone({ action: "select", value: item.value });
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
      const context = new Text(
        options.theme.fg("muted", safeBlock(options.context)),
        0,
        0,
      )
        .render(safeWidth)
        .slice(0, decorated ? 2 : 0);
      const navigationLabel = decorated
        ? [
            truncateToWidth(
              options.theme.fg(
                "muted",
                options.theme.bold(
                  `${safeInline(options.navigationLabel ?? "Tracked navigation")}${options.sort ? ` · sort ${options.sort}` : ""}`,
                ),
              ),
              safeWidth,
            ),
          ]
        : [];
      const listLines =
        options.items.length > 0
          ? list.render(safeWidth)
          : new Text(
              options.theme.fg("warning", safeInline(options.emptyMessage)),
              0,
              0,
            ).render(safeWidth);
      const disclosure = decorated
        ? new Text(
            options.theme.fg("warning", safeBlock(options.disclosure)),
            0,
            0,
          )
            .render(safeWidth)
            .slice(0, 2)
        : [];
      const footer = selectFooterLines(
        safeWidth,
        options.sort,
        options.allowReference ?? false,
      ).map((line) => options.theme.fg("customMessageText", line));
      const chrome = [
        ...(decorated ? border.render(safeWidth) : []),
        title,
        ...context,
        ...navigationLabel,
        ...listLines,
      ];
      const tail = [
        ...disclosure,
        ...footer,
        ...(decorated ? border.render(safeWidth) : []),
      ];
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
                  options.theme.bold(
                    safeInline(options.previewLabel ?? "Selected preview"),
                  ),
                ),
                safeWidth,
              ),
            ]
          : [];
      const previewHeight = Math.max(
        0,
        availablePreviewRows - previewChrome.length,
      );
      const previewContent = previewScroll.render(safeWidth);
      previewScroll.updateLayout(
        previewContent.length,
        previewHeight,
        options.requestRender,
      );
      const preview =
        previewHeight > 0
          ? previewContent.slice(
              previewScroll.scrollTop,
              previewScroll.scrollTop + previewHeight,
            )
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
      else if (data === "s" && options.sort) {
        options.onDone({ action: "sort" });
      } else if (data === "p" && options.allowReference && selectedValue) {
        options.onDone({ action: "reference", value: selectedValue });
      } else if (matchesKey(data, Key.pageUp)) {
        previewScroll.scrollBy(-Math.max(1, previewScroll.viewportHeight - 1));
      } else if (matchesKey(data, Key.pageDown)) {
        previewScroll.scrollBy(Math.max(1, previewScroll.viewportHeight - 1));
      } else if (options.items.length > 0) {
        list.handleInput(data);
      } else if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
        options.onDone({ action: "back" });
      }
      options.requestRender();
    },
  };
}

export const SPOOL_MODAL_HEIGHT_RATIO = 0.85;
export const SPOOL_MODAL_VERTICAL_PADDING = 2;
export const MAX_DETAIL_PANEL_ROWS = 27;

export interface StepDetailScreen extends Component {
  readonly scrollTop: number;
  readonly viewportHeight: number;
}

export function modalContentRows(terminalRows: number): number {
  const safeRows = Number.isFinite(terminalRows)
    ? Math.max(0, Math.floor(terminalRows))
    : 0;
  return Math.max(
    3,
    Math.floor(safeRows * SPOOL_MODAL_HEIGHT_RATIO) -
      SPOOL_MODAL_VERTICAL_PADDING,
  );
}

export function detailPanelRows(terminalRows: number): number {
  return Math.min(MAX_DETAIL_PANEL_ROWS, modalContentRows(terminalRows));
}

export function createStepDetailScreen(options: {
  detail: DashboardGoalDetail;
  step: DashboardStep;
  reference?: PkmTaskReference;
  theme: Theme;
  terminalRows: () => number;
  onDone: (result: "back" | "refresh" | "reference") => void;
  requestRender: () => void;
}): StepDetailScreen {
  const body = new Text("", 1, 0);
  let technical = false;
  const updateBody = (): void => {
    body.setText(
      styleStepDetail(
        formatStepDetailText(options.detail, options.step, {
          reference: options.reference,
          technical,
        }),
        options.step,
        options.theme,
      ),
    );
  };
  updateBody();
  const scroll = new ScrollView(body, {
    primary: true,
    overscroll: "contain",
    scrollbar: "hidden",
  });
  const topBorder = new DynamicBorder((text: string) =>
    options.theme.fg("accent", text),
  );
  const bottomBorder = new DynamicBorder((text: string) =>
    options.theme.fg("accent", text),
  );

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
      const header = decorated
        ? [
            ...topBorder.render(safeWidth),
            truncateToWidth(
              options.theme.fg("accent", options.theme.bold("Workflow step")),
              safeWidth,
            ),
          ]
        : [
            truncateToWidth(
              options.theme.fg("accent", options.theme.bold("Workflow step")),
              safeWidth,
            ),
          ];
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
          `Rows ${content.length === 0 ? 0 : start + 1}–${end}/${content.length} · ↑↓ scroll · i ${technical ? "hide" : "show"} technical · p PKM · r refresh · ${keyHint("tui.select.cancel", "back")}`,
        ),
        safeWidth,
      );
      return decorated
        ? [...header, ...visible, status, ...bottomBorder.render(safeWidth)]
        : [...header, ...visible, status];
    },
    invalidate() {
      body.invalidate();
      scroll.invalidate();
      topBorder.invalidate();
      bottomBorder.invalidate();
      updateBody();
    },
    handleInput(data) {
      if (data === "r") options.onDone("refresh");
      else if (data === "p") options.onDone("reference");
      else if (data === "i") {
        technical = !technical;
        updateBody();
        scroll.scrollToStart();
      } else if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
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

export function renderModalSurfaceLine(
  line: string,
  width: number,
  theme: Theme,
): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const padding = safeWidth >= 5 ? 2 : 0;
  const innerWidth = Math.max(1, safeWidth - padding * 2);
  const clipped = truncateToWidth(line, innerWidth, "");
  const background = theme.getBgAnsi("customMessageBg");
  const withContinuousBackground = clipped.replace(
    /\u001b\[([0-9;]*)m/g,
    (sequence, parameters: string) => {
      const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
      return codes.includes(0) || codes.includes(49)
        ? `${sequence}${background}`
        : sequence;
    },
  );
  const right = " ".repeat(
    Math.max(0, innerWidth - visibleWidth(withContinuousBackground)),
  );
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
      overlayOptions: () =>
        spoolOverlayOptions(liveTui?.terminal?.columns ?? 120),
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
      title: "Spool workflows",
      context: `${safeInline(snapshot.queueName)} · ${snapshot.totalGoals} goal(s) · snapshot ${formatRelativeTime(snapshot.snapshotAt, new Date())} · read-only`,
      items: goalSelectItems(snapshot, browser.references),
      navigationLabel: "Tracked workflows",
      previewLabel: "Selected workflow",
      preview: (value) => {
        const goal = snapshot.goals.find((item) => item.key === value);
        return goal
          ? formatGoalPreview(
              goal,
              browser.references.get(value),
              snapshot,
              theme,
            )
          : "";
      },
      emptyMessage: "No recorded Spool workflows in this configured queue.",
      disclosure:
        snapshot.omittedGoals > 0
          ? `${snapshot.omittedGoals} goal(s) omitted by the 50-goal display bound. Review / acceptance is not recorded.`
          : "Review / acceptance is not recorded.",
      sort: snapshot.sort,
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
  const scopeDisclosure =
    detail.goal.workCount > 1
      ? `${detail.goal.workCount} distinct work scopes share this vault/task ID; each step retains its exact scope. `
      : "";
  const title =
    reference?.status === "available" && reference.title
      ? reference.title
      : `${detail.goal.vault} / ${detail.goal.taskId}`;
  return await showModal(ctx, (tui, theme, done) =>
    createSelectScreen({
      title: safeInline(title),
      context: `${safeInline(detail.goal.vault)} / ${safeInline(detail.goal.taskId)} · ${formatDashboardCounts(detail.goal.counts)} · snapshot ${formatRelativeTime(detail.snapshotAt, new Date())}`,
      items: stepSelectItems(detail),
      navigationLabel: "Tracked steps",
      previewLabel: "Selected step",
      preview: (value) => {
        const step = detail.steps.find(
          (item) => dashboardStepKey(item) === value,
        );
        return step ? formatStepPreview(step, detail, theme) : "";
      },
      emptyMessage: "This recorded workflow has no materialized steps.",
      disclosure: `${scopeDisclosure}${detail.omittedSteps > 0 ? `${detail.omittedSteps} step(s) omitted by the 50-step display bound. ` : ""}Review / acceptance is not recorded.`,
      sort: detail.sort,
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
  detail: DashboardGoalDetail,
  step: DashboardStep,
  reference?: PkmTaskReference,
): Promise<"back" | "refresh" | "reference"> {
  return await showModal(ctx, (tui, theme, done) =>
    createStepDetailScreen({
      detail,
      step,
      reference,
      theme,
      terminalRows: () => tui.terminal.rows,
      onDone: done,
      requestRender: () => tui.requestRender(),
    }),
  );
}

export function formatPkmReferenceText(
  goal: DashboardGoal,
  reference: PkmTaskReference,
): string {
  const title =
    reference.status === "available" && reference.title
      ? safeInline(reference.title)
      : `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}`;
  const lines = [
    title,
    `${safeInline(goal.vault)} / ${safeInline(goal.taskId)}${reference.status === "available" && reference.project ? ` · project ${safeInline(reference.project)}` : ""}`,
    "",
    "Reference status",
    safeInline(reference.notice),
    "",
  ];
  if (reference.status === "available" && reference.goalText) {
    lines.push("Canonical PKM goal", safeBlock(reference.goalText), "");
  }
  lines.push(
    "Recorded Spool purpose",
    safeBlock(goal.latestOutcome),
    "",
    "Attribution details",
    `Canonical path: ${safeInline(reference.canonicalPath)}`,
    `Expected task ID: ${safeInline(reference.expectedTaskId)}`,
    `File task ID: ${reference.fileTaskId ? safeInline(reference.fileTaskId) : "not available"}`,
    "Read-only reference; no file or task state was changed.",
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
}): StepDetailScreen {
  const body = new Text("", 1, 0);
  const updateBody = (): void => {
    body.setText(
      formatPkmReferenceText(options.goal, options.reference)
        .split("\n")
        .map((line, index) => {
          if (index === 0) {
            return options.theme.fg("accent", options.theme.bold(line));
          }
          if (
            line === "Reference status" ||
            line === "Canonical PKM goal" ||
            line === "Recorded Spool purpose" ||
            line === "Attribution details"
          ) {
            return options.theme.fg("accent", options.theme.bold(line));
          }
          if (line === safeInline(options.reference.notice)) {
            return options.theme.fg(
              options.reference.status === "available"
                ? "success"
                : "warning",
              line,
            );
          }
          if (
            line.startsWith("Canonical path:") ||
            line.startsWith("Expected task ID:") ||
            line.startsWith("File task ID:") ||
            line.startsWith("Read-only reference")
          ) {
            return options.theme.fg("muted", line);
          }
          return options.theme.fg("text", line);
        })
        .join("\n"),
    );
  };
  updateBody();
  const scroll = new ScrollView(body, {
    primary: true,
    overscroll: "contain",
    scrollbar: "hidden",
  });
  const border = new DynamicBorder((text: string) =>
    options.theme.fg("borderAccent", text),
  );
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
      const header = decorated
        ? [
            ...border.render(safeWidth),
            truncateToWidth(
              options.theme.fg("accent", options.theme.bold("PKM reference")),
              safeWidth,
            ),
          ]
        : [truncateToWidth("PKM reference", safeWidth)];
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
          `Rows ${content.length === 0 ? 0 : start + 1}–${end}/${content.length} · ↑↓ scroll · ${keyHint("tui.select.cancel", "back")}`,
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
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        options.onDone();
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
  queueName: string;
  error: Error;
  backToGoals: boolean;
  theme: Theme;
  onDone: (result: "refresh" | "back") => void;
  requestRender: () => void;
}): Component {
  const safe = spoolUserFacingError(options.error);
  const message = safeInline(safe.message);
  const boundedMessage =
    message.length <= 1_000
      ? message
      : `${message.slice(0, 1_000)}… [error text truncated]`;
  return {
    render(width) {
      const container = new Container();
      container.addChild(
        new DynamicBorder((text: string) => options.theme.fg("error", text)),
      );
      container.addChild(
        new Text(
          options.theme.fg(
            "error",
            options.theme.bold("Spool snapshot unavailable"),
          ),
          1,
          0,
        ),
      );
      container.addChild(
        new Text(
          `${options.theme.fg("muted", `Queue: ${safeInline(options.queueName)}`)}\n${options.theme.fg("text", boundedMessage)}`,
          1,
          1,
        ),
      );
      container.addChild(
        new Text(
          options.theme.fg(
            "dim",
            `r retry once · ${keyHint("tui.select.cancel", options.backToGoals ? "back to goals" : "close")}`,
          ),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((text: string) => options.theme.fg("error", text)),
      );
      return container.render(width);
    },
    invalidate() {},
    handleInput: (data) => {
      if (data === "r") options.onDone("refresh");
      else if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c"))
      ) {
        options.onDone("back");
      }
      options.requestRender();
    },
  };
}

async function showError(
  ctx: ExtensionCommandContext,
  queueName: string,
  error: Error,
  backToGoals: boolean,
): Promise<"refresh" | "back"> {
  return await showModal(ctx, (tui, theme, done) =>
    createErrorScreen({
      queueName,
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
          error:
            error instanceof Error
              ? error
              : new Error("Unknown dashboard error"),
        });
      },
    );
    return loader;
  });
}
