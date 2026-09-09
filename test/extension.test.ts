import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  extractRuntimeIdentity,
  registerSpoolExtension,
  renderSpoolResult,
  type SpoolServiceLike,
} from "../src/index.ts";
import type { SessionBinding } from "../src/binding.ts";
import { DashboardCancelledError } from "../src/dashboard-data.ts";
import type { RuntimeIdentity } from "../src/spool-service.ts";

initTheme("dark", false);

const ESC = "\u001b";

const binding: SessionBinding = {
  version: 1,
  workId: "work_bound",
  vault: "zeebs_sb",
  taskId: "ALD-1",
  canonicalPath: "/tmp/ALD-1.md",
};

function context(
  sessionId = "real-session-id",
  entries: unknown[] = [{ type: "custom", customType: "spool-binding", data: binding }],
) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getBranch: () => entries,
    },
  } as unknown as ExtensionContext;
}

interface FakePi {
  tool: any;
  command: any;
  handlers: Map<string, (...args: any[]) => Promise<void> | void>;
  entries: Array<{ customType: string; data: unknown }>;
  api: ExtensionAPI;
}

function fakePi(sessionName = "test-session"): FakePi {
  const state: FakePi = {
    tool: undefined,
    command: undefined,
    handlers: new Map(),
    entries: [],
    api: undefined as unknown as ExtensionAPI,
  };
  state.api = {
    registerTool(definition: any) {
      state.tool = definition;
    },
    registerCommand(name: string, definition: any) {
      if (name === "spool") state.command = definition;
    },
    on(name: string, handler: (...args: any[]) => Promise<void> | void) {
      state.handlers.set(name, handler);
    },
    appendEntry(customType: string, data: unknown) {
      state.entries.push({ customType, data });
    },
    getSessionName: () => sessionName,
  } as unknown as ExtensionAPI;
  return state;
}

function stubService(overrides: Partial<SpoolServiceLike> = {}): SpoolServiceLike {
  return {
    async attach(input) {
      return { workId: "work_new", outcome: input.outcome ?? "", ...input };
    },
    async reconcileBinding(current) {
      return { ...current, outcome: "prove continuity" };
    },
    async resume(current) {
      return {
        goal: { ...current, outcome: "x" },
        current: null,
        nextAction: null,
        steps: [],
        omittedSteps: 0,
      };
    },
    async overview() {
      return { scope: "all", goals: [], omittedGoals: 0 };
    },
    async peek(reference) {
      return {
        goal: { workId: "work_peek", vault: "v", taskId: reference.taskId, canonicalPath: "/p", outcome: "" },
        current: null,
        nextAction: null,
        steps: [],
        omittedSteps: 0,
      };
    },
    async note(_b, _i, input) {
      return { recorded: "note", stepId: input.stepId, created: true, recordedAt: "t", warning: null };
    },
    async done(_b, _i, input) {
      return { recorded: "done", stepId: input.stepId, created: false, recordedAt: "t", warning: null };
    },
    async close() {},
    ...overrides,
  };
}

test("identity extraction uses public Pi context instead of tool arguments", () => {
  const identity = extractRuntimeIdentity(
    context(),
    { getSessionName: () => "actual-session-name" } as Pick<ExtensionAPI, "getSessionName">,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(identity, {
    piSessionId: "real-session-id",
    piSessionName: "actual-session-name",
    piSessionFile: "/sessions/real-session-id.jsonl",
    runtimeId: "11111111-1111-4111-8111-111111111111",
  });
});

test("extension startup is inert when machine configuration is absent", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spool-agent-dir-"));
  const pi = fakePi();
  let serviceCreations = 0;
  try {
    registerSpoolExtension(pi.api, {
      env: {},
      agentDir,
      createService: () => {
        serviceCreations += 1;
        throw new Error("service must not be created without config");
      },
      readTaskReference: async (input) => ({
        vault: "v",
        taskId: "T",
        canonicalPath: input.canonicalPath,
        title: null,
      }),
    });
    await pi.handlers.get("session_start")?.({}, context());
    assert.equal(serviceCreations, 0);
    await assert.rejects(
      pi.command.handler("", { ...context(), mode: "print", hasUI: false, ui: { notify() {} } }),
      /requires interactive Pi TUI mode/,
    );
    await assert.rejects(
      pi.tool.execute("1", { action: "resume" }, undefined, undefined, context()),
      /Spool is not configured.*spool\.json/,
    );
    assert.equal(serviceCreations, 0);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("dashboard cancellation aborts loading and closes its reader", async () => {
  const pi = fakePi();
  let closeCalls = 0;
  let loadAborted = false;
  let customOptions: any;
  const reader = {
    loadGoals(signal?: AbortSignal) {
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            loadAborted = true;
            reject(new DashboardCancelledError());
          },
          { once: true },
        );
      });
    },
    async loadGoal() {
      throw new Error("not used");
    },
    async loadStep() {
      throw new Error("not used");
    },
    async close() {
      closeCalls += 1;
    },
  };
  registerSpoolExtension(pi.api, {
    env: { SPOOL_DATABASE_URL: "postgresql://unused/test" },
    createService: () => {
      throw new Error("mutation service must remain unused");
    },
    createDashboardReader: () => reader,
  });
  const tui = { terminal: { columns: 120, rows: 33 }, requestRender() {} };
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const ctx = {
    ...context(),
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      async custom(factory: any, options: any) {
        customOptions = options;
        let component: any;
        const result = await new Promise((resolve) => {
          component = factory(tui, theme, {}, resolve);
          queueMicrotask(() => component.handleInput(ESC));
        });
        component.dispose?.();
        return result;
      },
    },
  } as unknown as ExtensionContext;
  await pi.command.handler("", ctx);
  assert.equal(loadAborted, true);
  assert.equal(customOptions.overlay, true);
  assert.equal(closeCalls, 1);
});

test("resume with canonicalPath attaches, persists the binding, and later calls reuse it", async () => {
  const pi = fakePi("pod-session");
  const calls: string[] = [];
  const identities: RuntimeIdentity[] = [];
  let closeCalls = 0;
  registerSpoolExtension(pi.api, {
    env: { SPOOL_DATABASE_URL: "postgresql://unused/test" },
    runtimeId: "11111111-1111-4111-8111-111111111111",
    readTaskReference: async (input) => ({
      vault: "nfhotel_sb",
      taskId: "NFN-4",
      canonicalPath: input.canonicalPath,
      title: "Scenario pack",
    }),
    createService: () =>
      stubService({
        async attach(input) {
          calls.push(`attach:${input.taskId}:${input.outcome}`);
          return { workId: "work_nfn4", outcome: input.outcome ?? "", ...input };
        },
        async resume(current, identity) {
          calls.push(`resume:${current.workId}`);
          identities.push(identity);
          return {
            goal: { ...current, outcome: "Scenario pack" },
            current: "pack",
            nextAction: "Draft S2",
            steps: [],
            omittedSteps: 0,
          };
        },
        async note(current, identity, input) {
          calls.push(`note:${current.workId}:${input.stepId}`);
          identities.push(identity);
          return {
            recorded: "note",
            stepId: input.stepId,
            created: true,
            recordedAt: "t",
            warning: "peer",
          };
        },
        async close() {
          closeCalls += 1;
        },
      }),
  });
  await pi.handlers.get("session_start")?.({}, context("fresh", []));
  await assert.rejects(
    pi.tool.execute(
      "1",
      { action: "note", stepId: "pack", summary: "x" },
      undefined,
      undefined,
      context("fresh", []),
    ),
    /no attached goal; call spool resume/,
  );
  const attached = await pi.tool.execute(
    "2",
    { action: "resume", canonicalPath: "/vaults/nfhotel_sb/tasks/NFN-4.md" },
    undefined,
    undefined,
    context("fresh", []),
  );
  assert.equal(attached.details.current, "pack");
  assert.deepEqual(pi.entries.at(-1), {
    customType: "spool-binding",
    data: {
      version: 1,
      workId: "work_nfn4",
      vault: "nfhotel_sb",
      taskId: "NFN-4",
      canonicalPath: "/vaults/nfhotel_sb/tasks/NFN-4.md",
    },
  });
  const noted = await pi.tool.execute(
    "3",
    { action: "note", stepId: "pack", summary: "drafting" },
    undefined,
    undefined,
    context("fresh", []),
  );
  assert.equal(noted.details.warning, "peer");
  assert.match(noted.content[0].text, /"warning":"peer"/);
  assert.deepEqual(calls, ["attach:NFN-4:Scenario pack", "resume:work_nfn4", "note:work_nfn4:pack"]);
  assert.equal(identities[0]!.piSessionId, "fresh");
  assert.equal(identities[0]!.piSessionName, "pod-session");
  await pi.handlers.get("session_shutdown")?.({}, context());
  await pi.handlers.get("session_shutdown")?.({}, context());
  assert.equal(closeCalls, 1);
});

test("a fresh session gets the overview, can peek, and only attaches on request", async () => {
  const pi = fakePi();
  const calls: string[] = [];
  registerSpoolExtension(pi.api, {
    env: { SPOOL_DATABASE_URL: "postgresql://unused/test" },
    createService: () =>
      stubService({
        async overview() {
          calls.push("overview");
          return {
            scope: "all",
            goals: [
              {
                vault: "nfhotel_sb",
                taskId: "NFN-1",
                canonicalPath: "/vaults/nfhotel_sb/tasks/NFN-1.md",
                outcome: "Pricing",
                openSteps: 1,
                doneSteps: 4,
                sessions: 3,
                lastActivityAt: "2026-09-09T14:17:00.000Z",
                current: null,
              },
            ],
            omittedGoals: 0,
          };
        },
        async peek(reference) {
          calls.push(`peek:${reference.taskId}`);
          return {
            goal: { workId: "work_peek", vault: "v", taskId: reference.taskId, canonicalPath: "/p", outcome: "" },
            current: "s",
            nextAction: "n",
            steps: [],
            omittedSteps: 0,
          };
        },
        async resume(current) {
          calls.push(`resume:${current.workId}`);
          return { goal: { ...current, outcome: "" }, current: null, nextAction: null, steps: [], omittedSteps: 0 };
        },
      }),
  });
  await pi.handlers.get("session_start")?.({}, context("fresh", []));
  const overview = await pi.tool.execute("1", { action: "resume" }, undefined, undefined, context("fresh", []));
  assert.equal(overview.details.scope, "all");
  assert.equal(overview.details.goals[0].taskId, "NFN-1");
  const peeked = await pi.tool.execute(
    "2",
    { action: "resume", taskId: "NFN-3" },
    undefined,
    undefined,
    context("fresh", []),
  );
  assert.equal(peeked.details.attached, false);
  assert.equal(peeked.details.current, "s");
  assert.equal(pi.entries.length, 0, "peek must not persist a binding");
  // An attached session can still ask for the overview.
  await pi.handlers.get("session_start")?.({}, context());
  const all = await pi.tool.execute("3", { action: "resume", scope: "all" }, undefined, undefined, context());
  assert.equal(all.details.scope, "all");
  const own = await pi.tool.execute("4", { action: "resume" }, undefined, undefined, context());
  assert.equal(own.details.goal.workId, "work_bound");
  assert.deepEqual(calls, ["overview", "peek:NFN-3", "overview", "resume:work_bound"]);
});

test("session restore recovers the branch binding without opening the database", async () => {
  const pi = fakePi();
  let serviceCreations = 0;
  const seen: string[] = [];
  registerSpoolExtension(pi.api, {
    env: { SPOOL_DATABASE_URL: "postgresql://unused/test" },
    createService: () => {
      serviceCreations += 1;
      return stubService({
        async resume(current) {
          seen.push(current.workId);
          return {
            goal: { ...current, outcome: "" },
            current: null,
            nextAction: null,
            steps: [],
            omittedSteps: 0,
          };
        },
      });
    },
  });
  await pi.handlers.get("session_start")?.({}, context());
  assert.equal(serviceCreations, 0);
  await pi.tool.execute("1", { action: "resume" }, undefined, undefined, context());
  assert.equal(serviceCreations, 1);
  assert.deepEqual(seen, ["work_bound"]);
});

test("binding-dependent tool calls are serialized", async () => {
  const pi = fakePi();
  let active = 0;
  let maxActive = 0;
  registerSpoolExtension(pi.api, {
    env: { SPOOL_DATABASE_URL: "postgresql://unused/test" },
    createService: () =>
      stubService({
        async note(_b, _i, input) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return {
            recorded: "note",
            stepId: input.stepId,
            created: true,
            recordedAt: "t",
            warning: null,
          };
        },
      }),
  });
  await pi.handlers.get("session_start")?.({}, context());
  await Promise.all(
    ["a", "b", "c"].map((step) =>
      pi.tool.execute(
        step,
        { action: "note", stepId: step, summary: "x" },
        undefined,
        undefined,
        context(),
      ),
    ),
  );
  assert.equal(maxActive, 1);
});

test("rendered output stays within the tool bound", () => {
  assert.match(renderSpoolResult("note", { recorded: "note" }), /^Spool note:\n\{"recorded":"note"\}$/);
  assert.throws(() => renderSpoolResult("resume", { big: "x".repeat(9_000) }), /output bound/);
});
