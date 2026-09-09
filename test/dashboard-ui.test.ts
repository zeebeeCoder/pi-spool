import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  dashboardGoalKey,
  groupGoalRows,
  nextDashboardSort,
  type DashboardGoalDetail,
  type DashboardGoalRow,
  type DashboardStep,
} from "../src/dashboard-data.ts";
import {
  createErrorScreen,
  createSelectScreen,
  createPkmReferenceScreen,
  createStepDetailScreen,
  formatExactLocalTime,
  formatGoalPreview,
  formatPkmReferenceText,
  formatStepPreview,
  formatRelativeTime,
  formatStepDetailText,
  formatStepStatus,
  goalSelectItems,
  modalContentRows,
  renderModalSurfaceLine,
  safeInline,
  selectFooterLines,
  spoolOverlayOptions,
  stepSelectItems,
} from "../src/dashboard-ui.ts";
import type { PkmTaskReference } from "../src/pkm-reference.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function goalRow(overrides: Partial<DashboardGoalRow> = {}): DashboardGoalRow {
  return {
    vault: "zeebs_sb",
    task_id: "ALD-1",
    latest_outcome: "Build durable work continuity",
    latest_canonical_path: "/vault/tasks/ALD-1.md",
    goal_created_at: new Date("2026-09-08T08:00:00Z"),
    goal_last_activity_at: new Date("2026-09-09T08:04:00Z"),
    work_count: "2",
    completed_count: "3",
    running_count: "1",
    ready_count: "2",
    reported_in_progress_count: "0",
    reported_finished_count: "0",
    session_count: "2",
    total_goals: "1",
    work_id: "work-a",
    canonical_path: "/vault/tasks/ALD-1.md",
    outcome: "Original scope",
    work_created_at: new Date("2026-09-08T08:00:00Z"),
    work_last_activity_at: new Date("2026-09-09T08:04:00Z"),
    ...overrides,
  };
}

function expiredStep(): DashboardStep {
  return {
    work: {
      workId: "work-a",
      canonicalPath: "/vault/tasks/ALD-1.md",
      outcome: "Build durable work continuity",
      createdAt: new Date("2026-09-08T08:00:00Z"),
      lastActivityAt: new Date("2026-09-09T08:04:00Z"),
    },
    stepId: "ald1.spool-tui-skeleton",
    title: "Unicode dashboard Żółć 🚦 ".repeat(20),
    contribution: "Show raw recorded continuity state without inventing progress. ".repeat(20),
    criteria: "Long evidence remains readable in a narrow terminal. ".repeat(20),
    createdAt: new Date("2026-09-08T08:05:00Z"),
    lastActivityAt: new Date("2026-09-09T08:04:00Z"),
    stepState: "running",
    taskState: "running",
    latestAttempt: {
      attempt: 2,
      piSessionId: "session-expired",
      piSessionName: "TUI evaluator",
      attemptState: "active",
      leaseStatus: "expired",
      leaseExpiresAt: new Date("2026-09-09T08:00:00Z"),
      isCurrentRuntimeOwner: false,
      claimedAt: new Date("2026-09-09T07:30:00Z"),
      lastActivityAt: new Date("2026-09-09T08:04:00Z"),
      lastTransition: "checkpointed",
      lastSummary: "Recorded checkpoint ui-ready",
      nextAction: "Seek reviewed acceptance after execution completion",
    },
    checkpoint: {
      name: "ui-ready",
      evidenceRef: `artifact:${"żółć/🚦/".repeat(80)}`,
      recordedAt: "2026-09-09T07:55:00.000Z",
    },
    completion: null,
  };
}

function pkmReference(
  overrides: Partial<PkmTaskReference> = {},
): PkmTaskReference {
  return {
    status: "available",
    canonicalPath: "/vault/tasks/ALD-1.md",
    expectedTaskId: "ALD-1",
    fileTaskId: "ALD-1",
    title: "Build a meaning-first durable workflow browser",
    project: "alpha-desk",
    goalText: "Understand the workflow without reconstructing raw database rows.",
    notice: "PKM attribution verified against the recorded task ID",
    ...overrides,
  };
}

function detail(step = expiredStep()): DashboardGoalDetail {
  const goal = groupGoalRows([
    goalRow(),
    goalRow({
      work_id: "work-b",
      canonical_path: "/vault/tasks/archive/ALD-1.md",
      outcome: "Earlier duplicate recorded scope",
    }),
  ])[0]!;
  return {
    queueName: "spool_dev",
    snapshotAt: new Date("2026-09-09T08:05:00Z"),
    readOnly: true,
    goal,
    totalSteps: 51,
    omittedSteps: 50,
    sort: "attention",
    steps: [step],
  };
}

test("duplicate goal scopes group without conflating work identity or counts", () => {
  const goals = groupGoalRows([
    goalRow(),
    goalRow({
      work_id: "work-b",
      canonical_path: "/vault/tasks/archive/ALD-1.md",
      outcome: "Earlier duplicate recorded scope",
    }),
  ]);
  assert.equal(goals.length, 1);
  assert.equal(goals[0]?.key, dashboardGoalKey("zeebs_sb", "ALD-1"));
  assert.equal(goals[0]?.workCount, 2);
  assert.deepEqual(
    goals[0]?.scopes.map((scope) => scope.workId),
    ["work-a", "work-b"],
  );
  assert.deepEqual(goals[0]?.counts, {
    executionCompleted: 3,
    running: 1,
    ready: 2,
    reportedInProgress: 0,
    reportedFinished: 0,
    participatingSessions: 2,
  });
  const goalItem = goalSelectItems({
    queueName: "spool_dev",
    snapshotAt: new Date(),
    readOnly: true,
    totalGoals: 1,
    omittedGoals: 0,
    sort: "attention",
    goals,
  })[0]!;
  assert.match(goalItem.description ?? "", /3 complete.*2 session/);
  assert.doesNotMatch(goalItem.description ?? "", /Build durable work continuity/);
});

test("PKM title attribution and temporal labels are meaning-first and sanitized", () => {
  const snapshot = {
    queueName: "spool_dev",
    snapshotAt: new Date("2026-09-09T08:05:00Z"),
    readOnly: true as const,
    totalGoals: 1,
    omittedGoals: 0,
    sort: "attention" as const,
    goals: detail().goal ? [detail().goal] : [],
  };
  const reference = pkmReference({
    title: "Readable \u001b]8;;https://evil.invalid\u0007workflow\u001b]8;;\u0007 title",
  });
  const references = new Map([[snapshot.goals[0]!.key, reference]]);
  const item = goalSelectItems(snapshot, references)[0]!;
  assert.equal(item.label, "Readable workflow title");
  assert.match(item.description ?? "", /zeebs_sb\/ALD-1/);
  assert.match(item.description ?? "", /recorded Spool activity 1m ago/);
  assert.equal(safeInline("safe\u001b[31m red\u001b[0m\ntext"), "safe red text");
  assert.equal(safeInline("safe\u009b31m C1\u009b0m text"), "safe C1 text");
  assert.equal(
    safeInline("safe\u001b]8;;https://example.invalid\u001b\\link\u001b]8;;\u001b\\ text"),
    "safelink text",
  );
  assert.equal(
    formatRelativeTime(
      new Date("2026-09-09T07:05:00Z"),
      snapshot.snapshotAt,
    ),
    "1h ago",
  );
  assert.match(formatExactLocalTime(snapshot.snapshotAt), /2026/);
  assert.deepEqual(spoolOverlayOptions(200), {
    anchor: "center",
    width: 112,
    minWidth: 40,
    maxHeight: "85%",
    margin: 1,
  });
  assert.equal(spoolOverlayOptions(30).width, 28);
  assert.equal(modalContentRows(33), 26);
  assert.equal(nextDashboardSort("attention"), "recent");
  assert.equal(nextDashboardSort("recent"), "oldest");
  assert.equal(nextDashboardSort("oldest"), "attention");
  const goalPreview = stripTerminalSequences(
    formatGoalPreview(snapshot.goals[0]!, reference, snapshot, theme),
  );
  assert.match(goalPreview, /Readable workflow title/);
  assert.match(goalPreview, /Original scope|Build durable work continuity/);
  assert.match(goalPreview, /Created .*last recorded Spool activity/);
  assert.match(goalPreview, /Activity outside Spool.*remains unknown/);
  const stepPreview = stripTerminalSequences(
    formatStepPreview(expiredStep(), detail(), theme),
  );
  assert.match(stepPreview, /Unicode dashboard/);
  assert.match(stepPreview, /What this contributes/);
  assert.match(stepPreview, /Useful next action/);
  assert.match(stepPreview, /Seek reviewed acceptance/);
  const markerTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => `<bold>${text}</bold>`,
  } as unknown as Theme;
  assert.match(
    formatStepPreview(expiredStep(), detail(), markerTheme),
    /<error>/,
  );
  const completed = { ...expiredStep(), stepState: "execution_completed" };
  completed.latestAttempt = {
    ...expiredStep().latestAttempt!,
    attemptState: "execution_completed",
    leaseStatus: "not_active",
  };
  assert.match(
    formatStepPreview(completed, detail(completed), markerTheme),
    /<success>/,
  );
  const ready = {
    ...expiredStep(),
    stepState: "ready",
    latestAttempt: null,
  };
  assert.match(formatStepPreview(ready, detail(ready), markerTheme), /<warning>/);
  const running = {
    ...expiredStep(),
    latestAttempt: {
      ...expiredStep().latestAttempt!,
      leaseStatus: "valid" as const,
    },
  };
  assert.match(formatStepPreview(running, detail(running), markerTheme), /<accent>/);
});

test("modal rows preserve theme background across clipping resets and padding", () => {
  const background = "\u001b[48;5;99m";
  const surfaceTheme = {
    getBgAnsi: () => background,
    bg: (_color: string, text: string) => `${background}${text}\u001b[49m`,
  } as unknown as Theme;
  const clippedChild = truncateToWidth(
    "\u001b[31mabcdef\u001b[49mghijklmnop",
    8,
    "…",
  );
  const rendered = renderModalSurfaceLine(clippedChild, 16, surfaceTheme);
  assert.equal(visibleWidth(rendered), 16);
  assert.match(rendered, /\u001b\[31m/, "foreground styling is preserved");
  assert.match(rendered, /\u001b\[49m\u001b\[48;5;99m/);
  assert.match(rendered, /\u001b\[0m\u001b\[48;5;99m…/);
  assert.match(rendered, /\u001b\[48;5;99m {6}\u001b\[49m$/);

  const compactFooter = selectFooterLines(24, "attention", true);
  assert.equal(compactFooter.length, 2);
  assert.deepEqual(compactFooter, [
    "↑↓/Enter · Pg preview",
    "s sort · p PKM · r · Esc",
  ]);
  for (const line of compactFooter) assert.ok(visibleWidth(line) <= 24);
  assert.deepEqual(selectFooterLines(108, "oldest", true), [
    "↑/↓ select · Enter open · PgUp/PgDn preview",
    "s sort:oldest · p PKM · r refresh · Esc back",
  ]);
});

test("selection screens use SDK navigation, refresh, sort, reference, and preview scrolling", () => {
  const selected: unknown[] = [];
  let renders = 0;
  const screen = createSelectScreen({
    title: "Spool goals",
    context: "Queue spool_dev · snapshot now · read-only",
    items: [
      { value: "a", label: "Readable ALD workflow", description: "first" },
      { value: "b", label: "Readable NFN workflow", description: "second" },
    ],
    preview: (value) =>
      `${value} full title\n\nRecorded workflow purpose\n${"purpose line\n".repeat(30)}TAIL ${value}`,
    emptyMessage: "none",
    disclosure: "Review / acceptance is not recorded.",
    sort: "attention",
    allowReference: true,
    theme,
    terminalRows: () => 33,
    onDone: (result) => selected.push(result),
    requestRender: () => {
      renders += 1;
    },
  });
  screen.handleInput?.("\u001b[B");
  screen.handleInput?.("\r");
  screen.handleInput?.("s");
  screen.handleInput?.("p");
  screen.handleInput?.("r");
  assert.deepEqual(selected, [
    { action: "select", value: "b" },
    { action: "sort" },
    { action: "reference", value: "b" },
    { action: "refresh" },
  ]);
  assert.ok(renders >= 3);
  const composed = stripTerminalSequences(screen.render(52).join("\n"));
  assert.ok(
    composed.indexOf("Tracked navigation") <
      composed.indexOf("Selected preview"),
  );
  assert.match(composed, /─+\nSelected preview/);
  assert.match(composed, /↑↓\/Enter select · Pg preview/);
  assert.match(composed, /s sort · p PKM · r reload · Esc back/);
  const narrow = screen.render(18);
  assert.ok(narrow.length <= 26);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 18);
  assert.doesNotMatch(narrow.join("\n"), /up up|down down/);
  for (let index = 0; index < 8; index += 1) {
    screen.handleInput?.("\u001b[6~");
  }
  assert.match(screen.render(52).join("\n"), /TAIL b/);

  let emptyAction: unknown;
  const empty = createSelectScreen({
    title: "Empty",
    context: "read-only",
    items: [],
    emptyMessage: "No recorded Spool goals.",
    disclosure: "No omissions.",
    theme,
    onDone: (result) => {
      emptyAction = result;
    },
    requestRender() {},
  });
  assert.match(empty.render(24).join("\n"), /No recorded/);
  empty.handleInput?.("\u001b");
  assert.deepEqual(emptyAction, { action: "back" });
});

test("expired active record is disclosed as not current ownership", () => {
  const step = expiredStep();
  const snapshot = detail(step);
  assert.match(formatStepStatus(step), /expired lease · last owner TUI evaluator/);
  const text = formatStepDetailText(snapshot, step);
  assert.match(text, /not current ownership/);
  assert.match(text, /Evidence: artifact:/);
  assert.match(
    text,
    /Latest recorded attempt next action: Seek reviewed acceptance/,
  );
  assert.doesNotMatch(text, /^Recorded next action:/m);
  assert.match(text, /Review \/ acceptance is not recorded/);
  assert.match(text, /50 of 51 step\(s\) are omitted/);
  const item = stepSelectItems(snapshot)[0]!;
  assert.equal(item.label, step.title.trim());
  assert.match(item.description ?? "", /expired lease.*scope work-a/);
  assert.doesNotMatch(item.description ?? "", /attempt 2|ald1\.spool/);
});

test("regular detail viewport keeps chrome visible and arrow scrolling effective", () => {
  let action: string | undefined;
  let terminalRows = 33;
  let renders = 0;
  const screen = createStepDetailScreen({
    detail: detail(),
    step: expiredStep(),
    theme,
    terminalRows: () => terminalRows,
    onDone: (value) => {
      action = value;
    },
    requestRender() {
      renders += 1;
    },
  });

  const initial = screen.render(52);
  assert.equal(initial.length, 26);
  assert.match(initial[1] ?? "", /Workflow step/);
  assert.match(initial[2] ?? "", /Unicode dashboard/);
  assert.match(initial.at(-2) ?? "", /Rows 1–/);
  const initialBody = initial[2];

  for (let index = 0; index < 20; index += 1) {
    screen.handleInput?.("\u001b[B");
  }
  const scrolled = screen.render(52);
  assert.ok(screen.scrollTop > 0);
  assert.notEqual(scrolled[2], initialBody);
  assert.match(scrolled[1] ?? "", /Workflow step/);
  assert.match(scrolled.at(-2) ?? "", /Rows 21–/);
  assert.equal(scrolled.length, 26);
  assert.ok(renders >= 20);

  for (let index = 0; index < 20; index += 1) {
    screen.handleInput?.("\u001b[A");
  }
  const returned = screen.render(52);
  assert.equal(screen.scrollTop, 0);
  assert.equal(returned[2], initialBody);

  terminalRows = 12;
  const resized = screen.render(22);
  assert.equal(resized.length, 8);
  assert.match(resized[1] ?? "", /Workflow step/);
  assert.match(resized[2] ?? "", /Unicode dashboard/);
  assert.match(resized.at(-2) ?? "", /Rows 1–/);
  for (const line of resized) assert.ok(visibleWidth(line) <= 22);

  screen.handleInput?.("i");
  let technicalVisible = false;
  for (let index = 0; index < 120 && !technicalVisible; index += 1) {
    const frame = screen.render(52).join("\n");
    technicalVisible = /Technical details/.test(frame);
    screen.handleInput?.("\u001b[6~");
  }
  assert.equal(technicalVisible, true);
  screen.handleInput?.("p");
  assert.equal(action, "reference");
  screen.handleInput?.("r");
  assert.equal(action, "refresh");
});

test("unclaimed detail collapses absent attempt fields and keeps technical IDs hidden", () => {
  const unclaimed: DashboardStep = {
    ...expiredStep(),
    title: "Unclaimed step",
    latestAttempt: null,
    checkpoint: null,
  };
  const text = formatStepDetailText(detail(unclaimed), unclaimed, {
    reference: pkmReference(),
  });
  assert.match(text, /No tracked attempt is recorded in Spool/);
  assert.match(text, /Activity outside Spool.*remains unknown/);
  assert.doesNotMatch(text, /nobody is working|overall idle/i);
  assert.doesNotMatch(text, /Attempt state:|Lease status:|Work ID:|Queue:/);
  assert.match(text, /PKM attribution/);
  const technical = formatStepDetailText(detail(unclaimed), unclaimed, {
    reference: pkmReference(),
    technical: true,
  });
  assert.match(technical, /Technical details/);
  assert.match(technical, /Work ID: work-a/);

  const reported: DashboardStep = {
    ...unclaimed,
    stepState: "reported_in_progress_untracked",
    report: {
      disposition: "in_progress",
      summary: "Implementation is underway outside lease ownership",
      evidenceRef: "git:working-tree",
      nextAction: "Finish tests",
      reporterPiSessionId: "session-reporter",
      reporterPiSessionName: "Ariadne",
      reportedAt: new Date("2026-09-09T08:04:00Z"),
    },
  };
  assert.match(
    formatStepStatus(reported),
    /reported in progress · untracked execution · reporter Ariadne/,
  );
  const reportedText = formatStepDetailText(detail(reported), reported);
  assert.match(reportedText, /Attributed report/);
  assert.match(reportedText, /Reporter-attributed status/);
  assert.match(
    reportedText,
    /not lease ownership, verified truth, or acceptance/,
  );
});

test("PKM reference panel exposes verified goal and clear fallback attribution", () => {
  const goal = detail().goal;
  const reference = pkmReference();
  const text = formatPkmReferenceText(goal, reference);
  assert.match(text, /Build a meaning-first durable workflow browser/);
  assert.match(text, /Canonical PKM goal/);
  assert.match(text, /Understand the workflow/);
  assert.match(text, /Canonical path: \/vault\/tasks\/ALD-1\.md/);

  let closed = false;
  const screen = createPkmReferenceScreen({
    goal,
    reference,
    theme,
    terminalRows: () => 33,
    onDone: () => {
      closed = true;
    },
    requestRender() {},
  });
  const frame = screen.render(40);
  assert.equal(frame.length, 26);
  for (const line of frame) assert.ok(visibleWidth(line) <= 40);
  screen.handleInput?.("\u001b");
  assert.equal(closed, true);

  const fallback = formatPkmReferenceText(
    goal,
    pkmReference({
      status: "missing",
      fileTaskId: null,
      title: null,
      project: null,
      goalText: null,
      notice: "Recorded PKM task file is missing",
    }),
  );
  assert.match(fallback, /Recorded PKM task file is missing/);
  assert.match(fallback, /Recorded Spool purpose/);
});

test("error screen retries only on r and closes on escape without leaking DSN", () => {
  const actions: string[] = [];
  const screen = createErrorScreen({
    queueName: "spool_dev",
    error: Object.assign(new Error("password TOPSECRET"), { code: "28P01" }),
    backToGoals: false,
    theme,
    onDone: (action) => actions.push(action),
    requestRender() {},
  });
  const rendered = screen.render(30).join("\n");
  assert.match(rendered, /Spool snapshot unavailable/);
  assert.doesNotMatch(rendered, /TOPSECRET/);
  screen.handleInput?.("x");
  assert.deepEqual(actions, []);
  screen.handleInput?.("r");
  screen.handleInput?.("\u001b");
  assert.deepEqual(actions, ["refresh", "back"]);
});
