#!/usr/bin/env node
// Phase 1 of the Absurd experiment: an unattended Pi pod run as an Absurd task.
//
//   node worker/pod.ts serve                       start a worker on queue spool_pods
//   node worker/pod.ts spawn --task ALD-1 --step <id> --assignment "<text>"
//                            [--cwd <dir>] [--tools read,bash] [--wait]
//   node worker/pod.ts status <taskID>
//
// What Absurd supplies here is supervision: a lease, retry after the process
// dies, an awaitable result, and per-message checkpoints visible in absurdctl
// or Habitat. What Pi supplies is the durable message log itself: the pod's
// session file. On retry the pod reopens that file and continues.
// Spool records the boundaries so the trace shows the pod beside human sessions.
import { parseArgs } from "node:util";
import { Absurd, type TaskContext } from "absurd-sdk";
import {
  SessionManager,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { readSpoolConfig } from "../src/config.ts";
import {
  SpoolService,
  createBoundedSpoolPool,
  type RuntimeIdentity,
} from "../src/spool-service.ts";

export const POD_QUEUE = "spool_pods";
export const POD_TASK = "spool-pod";
const CLAIM_TIMEOUT_SECONDS = Number(process.env.POD_CLAIM_TIMEOUT ?? 300);

export interface PodParams {
  vault: string;
  taskId: string;
  canonicalPath: string;
  stepId: string;
  title?: string;
  assignment: string;
  cwd: string;
  tools?: string[];
}

interface SessionInfo {
  sessionFile: string;
  sessionId: string;
}

interface MessageMark {
  index: number;
  role: string;
  at: string;
}

const config = readSpoolConfig();
const pool = createBoundedSpoolPool(config.databaseUrl);
const spool = new SpoolService(pool);
const absurd = new Absurd({ db: pool, queueName: POD_QUEUE });

absurd.registerTask<PodParams, { sessionFile: string; messages: number; summary: string }>(
  { name: POD_TASK, defaultMaxAttempts: 5 },
  async (params, ctx) => runPod(params, ctx),
);

async function runPod(params: PodParams, ctx: TaskContext) {
  const log = (line: string) => console.error(`[pod ${params.stepId}] ${line}`);

  // 1. The Pi session file is the message log. Created once, reopened on retry.
  const info = await ctx.step<SessionInfo>("session", async () => {
    const manager = SessionManager.create(params.cwd);
    manager.appendCustomEntry("spool-pod", { taskID: ctx.taskID, stepId: params.stepId });
    return { sessionFile: manager.getSessionFile()!, sessionId: manager.getSessionId() };
  });
  let manager: SessionManager;
  try {
    manager = SessionManager.open(info.sessionFile);
  } catch {
    manager = SessionManager.create(params.cwd);
    log(`session file missing; started a new one at ${manager.getSessionFile()}`);
  }

  // 2. Count the message checkpoints Absurd already holds for this task.
  let handle = await ctx.beginStep<MessageMark>("message");
  let checkpointed = 0;
  while (handle.done) {
    checkpointed += 1;
    handle = await ctx.beginStep<MessageMark>("message");
  }

  const binding = {
    version: 1 as const,
    workId: "",
    vault: params.vault,
    taskId: params.taskId,
    canonicalPath: params.canonicalPath,
  };
  const goal = await spool.attach({
    vault: params.vault,
    taskId: params.taskId,
    canonicalPath: params.canonicalPath,
  });
  binding.workId = goal.workId;
  const identity: RuntimeIdentity = {
    piSessionId: manager.getSessionId(),
    piSessionName: `pod:${params.stepId}`,
    piSessionFile: manager.getSessionFile() ?? null,
    runtimeId: "00000000-0000-4000-8000-0000000000ab",
  };

  await ctx.step("note-start", async () => {
    await spool.note(binding, identity, {
      stepId: params.stepId,
      title: params.title,
      summary: `Pod started as Absurd task ${ctx.taskID.slice(0, 8)}${checkpointed ? ` (retry after ${checkpointed} checkpointed messages)` : ""}`,
      evidenceRef: `pi-session:${info.sessionFile}`,
      nextAction: "Wait for the pod to finish; its result lands as a done event",
    });
    return true;
  });

  if (checkpointed > 0) {
    // Repeated step names auto-number, so every retry leaves its own note.
    await ctx.step("note-retry", async () => {
      await spool.note(binding, identity, {
        stepId: params.stepId,
        summary: `Pod resumed after the previous process died; ${checkpointed} message(s) already checkpointed`,
        evidenceRef: `absurd-task:${ctx.taskID}`,
      });
      return true;
    });
  }

  // 3. Open the agent on that session and checkpoint every message boundary.
  const { session } = await createAgentSession({
    cwd: params.cwd,
    sessionManager: manager,
    tools: params.tools,
  });
  const existing = session.messages.length;
  log(
    `${existing} message(s) in session, ${checkpointed} checkpointed in Absurd`,
  );

  // Checkpoints are written strictly in order; message events can arrive
  // faster than a round trip to Postgres.
  let chain: Promise<void> = Promise.resolve();
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end") return;
    const index = session.messages.length;
    const role = event.message.role;
    log(`message ${index} (${role})`);
    chain = chain
      .then(async () => {
        await ctx.completeStep(handle, { index, role, at: new Date().toISOString() });
        handle = await ctx.beginStep<MessageMark>("message");
        await ctx.heartbeat(CLAIM_TIMEOUT_SECONDS);
      })
      .catch((error: unknown) => log(`checkpoint failed: ${String(error)}`));
  });

  try {
    const last = session.messages.at(-1);
    if (!last) {
      await session.prompt(params.assignment);
    } else if (last.role === "assistant" && !session.isStreaming) {
      log("previous attempt already finished; not prompting again");
    } else {
      await ctx.step("resume-prompt", async () => true);
      await session.prompt(
        "The previous process running this task died before you finished. Continue from where you left off; do not repeat completed work.",
      );
    }
    await session.waitForIdle();
    await chain;
  } finally {
    unsubscribe();
  }

  const summary = lastAssistantText(session);
  await ctx.step("note-done", async () => {
    await spool.done(binding, identity, {
      stepId: params.stepId,
      summary: summary.slice(0, 500),
      evidenceRef: `pi-session:${info.sessionFile}`,
    });
    return true;
  });
  session.dispose();
  return { sessionFile: info.sessionFile, messages: session.messages.length, summary };
}

function lastAssistantText(session: AgentSession): string {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]!;
    if (message.role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((part): part is { type: "text"; text: string } => part?.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "(no assistant text)";
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      task: { type: "string" },
      step: { type: "string" },
      title: { type: "string" },
      assignment: { type: "string" },
      cwd: { type: "string" },
      tools: { type: "string" },
      wait: { type: "boolean", default: false },
      vault: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === "serve") {
    const worker = await absurd.startWorker({
      workerId: `pod-worker:${process.pid}`,
      claimTimeout: CLAIM_TIMEOUT_SECONDS,
      concurrency: 1,
      onError: (error) => console.error(`[worker] ${error.message}`),
    });
    console.error(`[worker] serving ${POD_QUEUE} as pid ${process.pid}`);
    const stop = async () => {
      await worker.close();
      await spool.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (command === "spawn") {
    const taskId = required("task", values.task);
    const stepId = required("step", values.step);
    const assignment = required("assignment", values.assignment);
    const view = await spool.peek(
      { taskId, vault: values.vault },
      { piSessionId: "spawn", piSessionName: null, piSessionFile: null, runtimeId: "00000000-0000-4000-8000-0000000000ab" },
    );
    const params: PodParams = {
      vault: view.goal.vault,
      taskId: view.goal.taskId,
      canonicalPath: view.goal.canonicalPath,
      stepId,
      title: values.title,
      assignment,
      cwd: values.cwd ?? process.cwd(),
      tools: values.tools?.split(",").map((tool) => tool.trim()).filter(Boolean),
    };
    const spawned = await absurd.spawn(POD_TASK, params, {
      idempotencyKey: `pod:${params.vault}:${params.taskId}:${params.stepId}`,
    });
    console.log(JSON.stringify(spawned, null, 2));
    if (values.wait) {
      const result = await absurd.awaitTaskResult(spawned.taskID, { queue: POD_QUEUE });
      console.log(JSON.stringify(result, null, 2));
    }
    await spool.close();
    return;
  }
  if (command === "status") {
    const taskID = required("taskID", positionals[1]);
    console.log(JSON.stringify(await absurd.fetchTaskResult(taskID, { queue: POD_QUEUE }), null, 2));
    await spool.close();
    return;
  }
  console.error("usage: pod serve | spawn --task --step --assignment [--cwd] [--tools] [--wait] | status <taskID>");
  process.exit(2);
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return value;
}

await main();
