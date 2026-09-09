#!/usr/bin/env node
// Phase 1 of the Absurd experiment: an unattended Pi pod run as an Absurd task.
//
//   node worker/pod.ts serve                       start a worker on queue spool_pods
//   node worker/pod.ts spawn --task ALD-1 --step <id> --assignment "<text>"
//                            [--cwd <dir>] [--tools read,bash] [--wait]
//   node worker/pod.ts status <taskID>
//   node worker/pod.ts fanout --task ALD-1 --step <id> --plan pods.json [--worktree-base <dir>] [--wait]
//
// Phase 2: `fanout` runs a coordinator as an Absurd task on its own queue. It
// prepares one git worktree per pod, spawns the pods, and awaits each result
// through a checkpointed wait, so the coordinator can die and resume as well.
//
// What Absurd supplies here is supervision: a lease, retry after the process
// dies, an awaitable result, and per-message checkpoints visible in absurdctl
// or Habitat. What Pi supplies is the durable message log itself: the pod's
// session file. On retry the pod reopens that file and continues.
// Spool records the boundaries so the trace shows the pod beside human sessions.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
export const FANOUT_QUEUE = "spool_fanout";
export const FANOUT_TASK = "spool-fanout";
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

export interface PodPlan {
  stepId: string;
  title?: string;
  assignment: string;
  tools?: string[];
  cwd?: string;
}

export interface FanoutParams {
  vault: string;
  taskId: string;
  canonicalPath: string;
  stepId: string;
  title?: string;
  repo: string;
  worktreeBase?: string;
  pods: PodPlan[];
}

interface PodOutcome {
  stepId: string;
  taskID: string;
  cwd: string;
  state: string;
  summary: string | null;
}

const fanout = new Absurd({ db: pool, queueName: FANOUT_QUEUE });

fanout.registerTask<FanoutParams, { pods: PodOutcome[] }>(
  { name: FANOUT_TASK, defaultMaxAttempts: 5 },
  async (params, ctx) => runFanout(params, ctx),
);

async function runFanout(params: FanoutParams, ctx: TaskContext) {
  const log = (line: string) => console.error(`[fanout ${params.stepId}] ${line}`);
  const goal = await spool.attach({
    vault: params.vault,
    taskId: params.taskId,
    canonicalPath: params.canonicalPath,
  });
  const binding = {
    version: 1 as const,
    workId: goal.workId,
    vault: params.vault,
    taskId: params.taskId,
    canonicalPath: params.canonicalPath,
  };
  const identity: RuntimeIdentity = {
    piSessionId: `fanout:${ctx.taskID}`,
    piSessionName: `coordinator:${params.stepId}`,
    piSessionFile: null,
    runtimeId: "00000000-0000-4000-8000-0000000000fa",
  };

  await ctx.step("note-start", async () => {
    await spool.note(binding, identity, {
      stepId: params.stepId,
      title: params.title,
      summary: `Coordinator started as Absurd task ${ctx.taskID.slice(0, 8)}; fanning out ${params.pods.length} pod(s)`,
      evidenceRef: `absurd-task:${ctx.taskID}`,
      nextAction: "Wait for every pod result; the coordinator records done when all have landed",
    });
    return true;
  });

  // One worktree per pod, created once. A retry reuses them.
  const cwds = await ctx.step<Record<string, string>>("worktrees", async () => {
    const result: Record<string, string> = {};
    for (const pod of params.pods) {
      if (pod.cwd) {
        result[pod.stepId] = pod.cwd;
        continue;
      }
      if (!params.worktreeBase) {
        result[pod.stepId] = params.repo;
        continue;
      }
      const dir = join(params.worktreeBase, pod.stepId);
      if (!existsSync(dir)) {
        execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], {
          cwd: params.repo,
          stdio: "pipe",
        });
        log(`worktree ${dir}`);
      }
      result[pod.stepId] = dir;
    }
    return result;
  });

  // Spawn every pod. Idempotency keys make this safe to repeat after a crash.
  const spawned: Record<string, string> = {};
  for (const pod of params.pods) {
    spawned[pod.stepId] = await ctx.step<string>(`spawn:${pod.stepId}`, async () => {
      const result = await absurd.spawn(
        POD_TASK,
        {
          vault: params.vault,
          taskId: params.taskId,
          canonicalPath: params.canonicalPath,
          stepId: pod.stepId,
          title: pod.title,
          assignment: pod.assignment,
          cwd: cwds[pod.stepId]!,
          tools: pod.tools,
        } satisfies PodParams,
        { idempotencyKey: `pod:${params.vault}:${params.taskId}:${pod.stepId}` },
      );
      log(`spawned ${pod.stepId} as ${result.taskID.slice(0, 8)}${result.created ? "" : " (existing)"}`);
      return result.taskID;
    });
  }

  // Await each result. The wait itself is a checkpoint, so a resumed
  // coordinator skips pods that already answered.
  const outcomes: PodOutcome[] = [];
  for (const pod of params.pods) {
    const taskID = spawned[pod.stepId]!;
    const snapshot = await ctx.awaitTaskResult(taskID, {
      queue: POD_QUEUE,
      stepName: `await:${pod.stepId}`,
    });
    const summary =
      snapshot.state === "completed" && snapshot.result && typeof snapshot.result === "object"
        ? String((snapshot.result as { summary?: unknown }).summary ?? "")
        : null;
    outcomes.push({ stepId: pod.stepId, taskID, cwd: cwds[pod.stepId]!, state: snapshot.state, summary });
    log(`${pod.stepId} ${snapshot.state}`);
  }

  await ctx.step("note-done", async () => {
    const completed = outcomes.filter((o) => o.state === "completed").length;
    await spool.done(binding, identity, {
      stepId: params.stepId,
      summary: `${completed}/${outcomes.length} pod(s) completed: ${outcomes.map((o) => `${o.stepId}=${o.state}`).join(", ")}`,
      evidenceRef: outcomes.map((o) => `absurd-task:${o.taskID}`).join("; "),
    });
    return true;
  });
  return { pods: outcomes };
}

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
      plan: { type: "string" },
      "worktree-base": { type: "string" },
      concurrency: { type: "string" },
    },
  });
  const command = positionals[0];
  if (command === "serve") {
    const concurrency = Number(values.concurrency ?? 3);
    const worker = await absurd.startWorker({
      workerId: `pod-worker:${process.pid}`,
      claimTimeout: CLAIM_TIMEOUT_SECONDS,
      concurrency,
      onError: (error) => console.error(`[worker] ${error.message}`),
    });
    const coordinator = await fanout.startWorker({
      workerId: `fanout-worker:${process.pid}`,
      claimTimeout: CLAIM_TIMEOUT_SECONDS,
      concurrency: 1,
      onError: (error) => console.error(`[fanout-worker] ${error.message}`),
    });
    console.error(
      `[worker] serving ${POD_QUEUE} (x${concurrency}) and ${FANOUT_QUEUE} as pid ${process.pid}`,
    );
    const stop = async () => {
      await Promise.all([worker.close(), coordinator.close()]);
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
  if (command === "fanout") {
    const taskId = required("task", values.task);
    const stepId = required("step", values.step);
    const planPath = required("plan", values.plan);
    const pods = JSON.parse(readFileSync(planPath, "utf8")) as PodPlan[];
    if (!Array.isArray(pods) || pods.length === 0) {
      console.error("plan must be a non-empty JSON array of {stepId, assignment, ...}");
      process.exit(2);
    }
    const view = await spool.peek(
      { taskId, vault: values.vault },
      { piSessionId: "fanout-cli", piSessionName: null, piSessionFile: null, runtimeId: "00000000-0000-4000-8000-0000000000fa" },
    );
    const params: FanoutParams = {
      vault: view.goal.vault,
      taskId: view.goal.taskId,
      canonicalPath: view.goal.canonicalPath,
      stepId,
      title: values.title,
      repo: resolve(values.cwd ?? process.cwd()),
      worktreeBase: values["worktree-base"] ? resolve(values["worktree-base"]) : undefined,
      pods,
    };
    const spawned = await fanout.spawn(FANOUT_TASK, params, {
      idempotencyKey: `fanout:${params.vault}:${params.taskId}:${params.stepId}`,
    });
    console.log(JSON.stringify(spawned, null, 2));
    if (values.wait) {
      const result = await fanout.awaitTaskResult(spawned.taskID, { queue: FANOUT_QUEUE });
      console.log(JSON.stringify(result, null, 2));
    }
    await spool.close();
    return;
  }
  if (command === "status") {
    const taskID = required("taskID", positionals[1]);
    const pod = await absurd.fetchTaskResult(taskID, { queue: POD_QUEUE });
    const parent = pod ? null : await fanout.fetchTaskResult(taskID, { queue: FANOUT_QUEUE });
    console.log(JSON.stringify(pod ?? parent, null, 2));
    await spool.close();
    return;
  }
  console.error(
    "usage: pod serve [--concurrency n] | spawn --task --step --assignment [--cwd] [--tools] [--wait] | fanout --task --step --plan <file> [--worktree-base <dir>] [--wait] | status <taskID>",
  );
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
