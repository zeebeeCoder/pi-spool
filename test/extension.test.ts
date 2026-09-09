import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  extractRuntimeIdentity,
  registerSpoolExtension,
  type SpoolServiceLike,
} from "../src/index.ts";
import type { SessionBinding } from "../src/binding.ts";
import type { RuntimeIdentity } from "../src/spool-service.ts";

const binding: SessionBinding = {
  version: 1,
  workId: "work_bound",
  vault: "zeebs_sb",
  taskId: "ALD-1",
  canonicalPath: "/tmp/ALD-1.md",
  stepId: "recovery-proof",
};

function context(sessionId = "real-session-id") {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
      getBranch: () => [
        { type: "custom", customType: "spool-binding", data: binding },
      ],
    },
  } as unknown as ExtensionContext;
}

test("identity extraction uses public Pi context instead of tool arguments", () => {
  const identity = extractRuntimeIdentity(
    context(),
    { getSessionName: () => "actual-session-name" } as Pick<
      ExtensionAPI,
      "getSessionName"
    >,
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
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => Promise<void> | void>();
  let serviceCreations = 0;
  const fakePi = {
    registerTool(definition: any) {
      tool = definition;
    },
    on(name: string, handler: (...args: any[]) => Promise<void> | void) {
      handlers.set(name, handler);
    },
    appendEntry() {},
    getSessionName: () => "inert-startup",
  } as unknown as ExtensionAPI;

  try {
    registerSpoolExtension(fakePi, {
      env: {},
      agentDir,
      createService: () => {
        serviceCreations += 1;
        throw new Error("service must not be created without config");
      },
      validateTaskReference: async (input) => input,
    });
    await handlers.get("session_start")?.({}, context());
    assert.equal(serviceCreations, 0);
    await assert.rejects(
      tool.execute(
        "attach",
        {
          action: "attach",
          vault: "vault",
          taskId: "CFG-1",
          canonicalPath: "/tmp/CFG-1.md",
          outcome: "prove lazy configuration",
        },
        undefined,
        undefined,
        context(),
      ),
      /Spool is not configured.*spool\.json/,
    );
    assert.equal(serviceCreations, 0);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("extension restores lineage lazily, registers one tool, and closes once", async () => {
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => Promise<void> | void>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let serviceCreations = 0;
  let closeCalls = 0;
  let claimedIdentity: RuntimeIdentity | undefined;

  const service: SpoolServiceLike = {
    async attach() {
      throw new Error("not used");
    },
    async reconcileBinding() {
      return {
        workId: binding.workId,
        queueName: "spool_test",
        vault: binding.vault,
        taskId: binding.taskId,
        canonicalPath: binding.canonicalPath,
        outcome: "prove continuity",
      };
    },
    async materialize() {
      throw new Error("not used");
    },
    async claimNext(_binding, identity) {
      claimedIdentity = identity;
      return {
        attemptId: "22222222-2222-4222-8222-222222222222",
        workId: binding.workId,
        stepId: "recovery-proof",
        taskId: "33333333-3333-4333-8333-333333333333",
        runId: "44444444-4444-4444-8444-444444444444",
        attempt: 1,
        leaseExpiresAt: new Date("2026-09-08T12:00:00Z"),
      };
    },
    async checkpoint() {},
    async heartbeat() {
      return new Date("2026-09-08T12:00:00Z");
    },
    async completeExecution() {},
    async resume() {
      throw new Error("not used");
    },
    async close() {
      closeCalls += 1;
    },
  };

  const fakePi = {
    registerTool(definition: any) {
      tool = definition;
    },
    on(name: string, handler: (...args: any[]) => Promise<void> | void) {
      handlers.set(name, handler);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    getSessionName() {
      return "actual-name";
    },
  } as unknown as ExtensionAPI;

  registerSpoolExtension(fakePi, {
    env: {
      SPOOL_DATABASE_URL: "postgresql://unused/test",
      SPOOL_QUEUE: "spool_test",
    },
    runtimeId: "11111111-1111-4111-8111-111111111111",
    createService() {
      serviceCreations += 1;
      return service;
    },
  });

  assert.equal(tool.name, "spool");
  assert.equal(serviceCreations, 0, "registration is resource-lazy");
  await handlers.get("session_start")?.({}, context());
  assert.equal(serviceCreations, 0, "binding restore does not open a pool");

  const result = await tool.execute(
    "tool-call",
    { action: "claim", expectedStepId: "recovery-proof" },
    undefined,
    undefined,
    context(),
  );
  assert.equal(serviceCreations, 1);
  assert.deepEqual(claimedIdentity, {
    piSessionId: "real-session-id",
    piSessionName: "actual-name",
    piSessionFile: "/sessions/real-session-id.jsonl",
    runtimeId: "11111111-1111-4111-8111-111111111111",
  });
  assert.match(result.content[0].text, /"claimed":true/);
  assert.equal(entries.at(-1)?.customType, "spool-binding");
  assert.equal((entries.at(-1)?.data as SessionBinding).stepId, "recovery-proof");

  await handlers.get("session_shutdown")?.({}, context());
  await handlers.get("session_shutdown")?.({}, context());
  assert.equal(closeCalls, 1);
});


test("binding-dependent tool calls are serialized and capture one binding", async () => {
  let tool: any;
  const handlers = new Map<string, (...args: any[]) => Promise<void> | void>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let releaseReconcile!: () => void;
  let enteredReconcile!: () => void;
  const reconcileGate = new Promise<void>((resolve) => {
    releaseReconcile = resolve;
  });
  const reconcileEntered = new Promise<void>((resolve) => {
    enteredReconcile = resolve;
  });
  let materializedWorkId: string | undefined;
  let attachCalls = 0;
  let resumeCalls = 0;

  const service: SpoolServiceLike = {
    async attach(input) {
      attachCalls += 1;
      return {
        workId: "work_b",
        queueName: "spool_test",
        vault: input.vault,
        taskId: input.taskId,
        canonicalPath: input.canonicalPath,
        outcome: input.outcome,
      };
    },
    async reconcileBinding(current) {
      enteredReconcile();
      await reconcileGate;
      return {
        workId: current.workId,
        queueName: "spool_test",
        vault: current.vault,
        taskId: current.taskId,
        canonicalPath: current.canonicalPath,
        outcome: "bound A",
      };
    },
    async materialize(current, definition) {
      materializedWorkId = current.workId;
      return {
        stepId: definition.stepId,
        taskId: "33333333-3333-4333-8333-333333333333",
        created: true,
      };
    },
    async claimNext() {
      return null;
    },
    async checkpoint() {},
    async heartbeat() {
      return new Date("2026-09-08T12:00:00Z");
    },
    async completeExecution() {},
    async resume() {
      resumeCalls += 1;
      throw new Error("aborted status must not reach service");
    },
    async close() {},
  };
  const fakePi = {
    registerTool(definition: any) {
      tool = definition;
    },
    on(name: string, handler: (...args: any[]) => Promise<void> | void) {
      handlers.set(name, handler);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    getSessionName: () => "actual-name",
  } as unknown as ExtensionAPI;

  registerSpoolExtension(fakePi, {
    env: {
      SPOOL_DATABASE_URL: "postgresql://unused/test",
      SPOOL_QUEUE: "spool_test",
    },
    runtimeId: "11111111-1111-4111-8111-111111111111",
    createService: () => service,
    validateTaskReference: async (input) => ({
      vault: input.vault,
      taskId: input.taskId,
      canonicalPath: input.canonicalPath,
    }),
  });
  await handlers.get("session_start")?.({}, context());
  assert.ok(handlers.has("session_tree"));

  const materialize = tool.execute(
    "materialize",
    {
      action: "materialize",
      stepId: "step-a",
      title: "Step A",
      contribution: "remain on work A",
      criteria: "do not race attachment",
    },
    undefined,
    undefined,
    context(),
  );
  await reconcileEntered;

  const attach = tool.execute(
    "attach",
    {
      action: "attach",
      vault: "vault",
      taskId: "B-1",
      canonicalPath: "/tmp/B-1.md",
      outcome: "bind B only after A operation finishes",
    },
    undefined,
    undefined,
    context(),
  );
  const abortController = new AbortController();
  const abortedStatus = tool.execute(
    "status",
    { action: "status" },
    abortController.signal,
    undefined,
    context(),
  );
  abortController.abort();
  await Promise.resolve();
  assert.equal(attachCalls, 0, "concurrent attach waits behind binding operation");

  releaseReconcile();
  await materialize;
  await attach;
  await assert.rejects(abortedStatus, /cancelled while queued/);
  assert.equal(materializedWorkId, "work_bound");
  assert.equal(attachCalls, 1);
  assert.equal(resumeCalls, 0);
  assert.equal((entries.at(-1)?.data as SessionBinding).workId, "work_b");
});
