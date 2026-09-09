import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type {
  DashboardEvent,
  DashboardGoal,
  DashboardGoalDetail,
  DashboardSnapshot,
  DashboardStep,
  DashboardStepHistory,
} from "../src/dashboard-data.ts";
import {
  createErrorScreen,
  createSelectScreen,
  createStepDetailScreen,
  formatEventLine,
  formatGoalPreview,
  formatPkmReferenceText,
  formatRelativeTime,
  formatStepDetailText,
  formatStepPreview,
  formatStepStatus,
  goalSelectItems,
  modalContentRows,
  safeInline,
  stepSelectItems,
} from "../src/dashboard-ui.ts";
import type { PkmTaskReference } from "../src/pkm-reference.ts";

initTheme("dark", false);

const ESC = "\u001b";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  getBgAnsi: () => "",
} as unknown as Theme;

const now = new Date("2026-09-09T15:00:00Z");

const goal: DashboardGoal = {
  workId: "work-a",
  vault: "nfhotel_sb",
  taskId: "NFN-1",
  canonicalPath: "/vaults/nfhotel_sb/tasks/NFN-1.md",
  outcome: "Define the pricing domain",
  createdAt: new Date("2026-09-09T09:00:00Z"),
  lastActivityAt: new Date("2026-09-09T14:17:00Z"),
  openSteps: 1,
  doneSteps: 4,
  sessions: 3,
};

function event(overrides: Partial<DashboardEvent> = {}): DashboardEvent {
  return {
    kind: "note",
    summary: `Recorded checkpoint${ESC}[31m scenario-discovery-task-created`,
    evidenceRef: "pkm:nfhotel_sb/NFN-4",
    nextAction: "Resume NFN-4 and draft S2",
    reviewed: false,
    sessionId: "01a085e4-77e1-74c0-bfd8-e27081ef4af0",
    sessionName: null,
    sessionFile: null,
    recordedAt: new Date("2026-09-09T14:17:00Z"),
    mine: false,
    ...overrides,
  };
}

const openStep: DashboardStep = {
  stepId: "nfn1.target-domain-storage-options",
  title: "Draft the target pricing domain",
  state: "open",
  reviewed: false,
  createdAt: new Date("2026-09-09T09:48:00Z"),
  lastActivityAt: new Date("2026-09-09T14:17:00Z"),
  eventCount: 5,
  last: event(),
};

const doneStep: DashboardStep = {
  ...openStep,
  stepId: "nfn1.as-is-synthesis",
  title: "Synthesize the as-is model",
  state: "done",
  reviewed: true,
  eventCount: 2,
  last: event({ kind: "done", reviewed: true, sessionName: "pod-nfn1-research", nextAction: null }),
};

const snapshot: DashboardSnapshot = {
  snapshotAt: now,
  totalGoals: 1,
  omittedGoals: 0,
  goals: [goal],
};
const detail: DashboardGoalDetail = {
  snapshotAt: now,
  goal,
  totalSteps: 2,
  omittedSteps: 0,
  steps: [openStep, doneStep],
};
const reference: PkmTaskReference = {
  status: "available",
  canonicalPath: goal.canonicalPath,
  expectedTaskId: "NFN-1",
  fileTaskId: "NFN-1",
  title: "Pricing domain for NF Next",
  project: "nf_next",
  goalText: "Define it.",
  notice: "PKM attribution verified against the recorded task ID",
};

test("list items lead with human titles and plain status", () => {
  const goals = goalSelectItems(snapshot, new Map([[goal.workId, reference]]));
  assert.equal(goals[0]!.label, "Pricing domain for NF Next");
  assert.match(goals[0]!.description!, /1 open · 4 done · 3 sessions · 43m ago/);
  const steps = stepSelectItems(detail);
  assert.equal(steps[0]!.label, "Draft the target pricing domain");
  assert.equal(formatStepStatus(openStep), "open · last 01a085e4…");
  assert.equal(formatStepStatus(doneStep), "done · reviewed · by pod-nfn1-research");
  assert.equal(
    formatStepStatus({ ...openStep, last: event({ mine: true }) }),
    "open · last this session",
  );
});

test("previews and event lines are sanitized and mention next action", () => {
  const preview = formatStepPreview(openStep, detail, theme);
  assert.ok(!preview.includes(ESC));
  assert.match(preview, /Next action\nResume NFN-4 and draft S2/);
  assert.match(preview, /5 entries/);
  const goalPreview = formatGoalPreview(goal, reference, snapshot, theme);
  assert.match(goalPreview, /^Pricing domain for NF Next\n/);
  assert.match(goalPreview, /project nf_next/);
  const line = formatEventLine(event({ kind: "done", reviewed: true, sessionName: "alpha" }), now);
  assert.equal(
    line,
    "done (reviewed) · alpha · 43m ago\n  Recorded checkpoint scenario-discovery-task-created\n  evidence: pkm:nfhotel_sb/NFN-4\n  next: Resume NFN-4 and draft S2",
  );
  assert.equal(safeInline(`a${ESC}[1mb\r\nc`), "ab c");
});

test("step detail shows history newest first and technical details last", () => {
  const history: DashboardStepHistory = {
    snapshotAt: now,
    goal,
    step: openStep,
    events: [
      event(),
      event({
        summary: "Started",
        sessionName: "coordinator",
        mine: true,
        nextAction: null,
        evidenceRef: null,
      }),
    ],
    omittedEvents: 2,
  };
  const text = formatStepDetailText(history, reference);
  const lines = text.split("\n");
  assert.equal(lines[0], "Draft the target pricing domain");
  assert.equal(lines[1], "open · last 01a085e4… · 43m ago");
  assert.ok(lines.indexOf("History") < lines.indexOf("Goal"));
  assert.ok(lines.indexOf("Goal") < lines.indexOf("Details"));
  assert.match(text, /note · 01a085e4… · 43m ago\n  Recorded checkpoint/);
  assert.match(text, /note · this session · 43m ago\n  Started/);
  assert.match(text, /2 older entries not shown\./);
  assert.match(text, /Pricing domain for NF Next · nfhotel_sb \/ NFN-1/);
  assert.match(text, /Step ID: nfn1.target-domain-storage-options/);
  const screen = createStepDetailScreen({
    history,
    reference,
    theme,
    terminalRows: () => 40,
    onDone: () => {},
    requestRender: () => {},
  });
  const rendered = screen.render(80).map(stripTerminalSequences);
  assert.ok(rendered.some((line) => line.includes("Step")));
  assert.ok(rendered.some((line) => line.includes("Draft the target pricing domain")));
  assert.ok(rendered.at(-2)!.includes("Rows 1–"));
});

test("select screen renders list, preview, and footer within the modal height", () => {
  let result: unknown;
  const screen = createSelectScreen({
    title: "Spool work log",
    context: "1 goal(s)",
    items: goalSelectItems(snapshot),
    preview: () => formatGoalPreview(goal, undefined, snapshot, theme),
    emptyMessage: "none",
    allowReference: true,
    theme,
    terminalRows: () => 30,
    onDone: (value) => {
      result = value;
    },
    requestRender: () => {},
  });
  const lines = screen.render(90).map(stripTerminalSequences);
  assert.ok(lines.length <= modalContentRows(30));
  assert.ok(lines.some((line) => line.includes("nfhotel_sb / NFN-1")));
  assert.ok(lines.some((line) => line.includes("p PKM · r refresh · Esc back")));
  screen.handleInput!("r");
  assert.deepEqual(result, { action: "refresh" });
  screen.handleInput!("p");
  assert.deepEqual(result, { action: "reference", value: "work-a" });
  const empty = createSelectScreen({
    title: "t",
    context: "c",
    items: [],
    emptyMessage: "No goals recorded yet.",
    theme,
    onDone: (value) => {
      result = value;
    },
    requestRender: () => {},
  });
  assert.ok(
    empty
      .render(60)
      .map(stripTerminalSequences)
      .some((l) => l.includes("No goals recorded yet.")),
  );
  empty.handleInput!(ESC);
  assert.deepEqual(result, { action: "back" });
});

test("PKM reference and error screens stay plain", () => {
  const text = formatPkmReferenceText(goal, reference);
  assert.match(text, /^Pricing domain for NF Next\n/);
  assert.match(text, /PKM goal\nDefine it\./);
  assert.match(text, /Task file: \/vaults\/nfhotel_sb\/tasks\/NFN-1.md/);
  let choice: unknown;
  const screen = createErrorScreen({
    error: new Error(`boom ${ESC}[31mred`),
    backToGoals: false,
    theme,
    onDone: (value) => {
      choice = value;
    },
    requestRender: () => {},
  });
  const lines = screen.render(60).map(stripTerminalSequences);
  assert.ok(lines.some((line) => line.includes("Spool unavailable")));
  assert.ok(lines.some((line) => line.includes("boom red")));
  screen.handleInput!("r");
  assert.equal(choice, "refresh");
});

test("relative time is compact", () => {
  assert.equal(formatRelativeTime(new Date(now.getTime() - 2_000), now), "just now");
  assert.equal(formatRelativeTime(new Date(now.getTime() - 90_000), now), "2m ago");
  assert.equal(formatRelativeTime(new Date(now.getTime() - 7_200_000), now), "2h ago");
  assert.equal(formatRelativeTime(new Date(now.getTime() + 60_000), now), "in 1m");
});
