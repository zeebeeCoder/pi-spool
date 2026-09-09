import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SPOOL_BINDING_ENTRY,
  readCanonicalTaskReference,
  restoreBinding,
  type SessionBinding,
} from "./binding.ts";
import { readSpoolConfig, type SpoolConfig } from "./config.ts";
import { SpoolDashboardReader } from "./dashboard-data.ts";
import { runSpoolDashboard, type DashboardReaderLike } from "./dashboard-ui.ts";
import { PkmReferenceReader, type PkmReferenceReaderLike } from "./pkm-reference.ts";
import {
  SpoolService,
  spoolUserFacingError,
  type OverviewPacket,
  type RecordResult,
  type ResumePacket,
  type RuntimeIdentity,
  type WorkRecord,
} from "./spool-service.ts";
import {
  FIELD_LIMITS,
  SPOOL_ACTIONS,
  STEP_ID_PATTERN,
  parseSpoolToolInput,
  type SpoolToolInput,
} from "./tool-contract.ts";

const stepIdPattern = STEP_ID_PATTERN.source;

export const spoolParameters = Type.Object(
  {
    action: StringEnum([...SPOOL_ACTIONS], {
      description:
        "resume: where work stands. With no attached goal it lists all goals; with canonicalPath it attaches a PKM task; with taskId it peeks at another goal without attaching; scope=all forces the overview. note: record progress on a step. done: mark a step finished.",
    }),
    canonicalPath: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.canonicalPath,
        description:
          "resume only: absolute path of the PKM task file to attach; its frontmatter id becomes the task ID.",
      }),
    ),
    vault: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.vault,
        description:
          "resume only, optional: vault name when it cannot be derived from a vaults/<name>/ path segment.",
      }),
    ),
    outcome: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.outcome,
        description: "resume only, optional: one sentence on the desired outcome.",
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.taskId,
        description:
          "resume only, optional: PKM task ID of another goal to view read-only without changing this session's attachment (add vault if ambiguous).",
      }),
    ),
    scope: Type.Optional(
      StringEnum(["goal", "all"], {
        description:
          "resume only, optional: all returns the overview of every goal even when this session is attached.",
      }),
    ),
    stepId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.stepId,
        pattern: stepIdPattern,
        description:
          "note/done: stable step identifier (letters, digits, . _ : -). A new ID creates the step.",
      }),
    ),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.title,
        description: "note only, optional: human title for a new step.",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.summary,
        description: "note/done: what happened, in one or two sentences.",
      }),
    ),
    evidenceRef: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.evidenceRef,
        description:
          "note/done, optional: where the evidence lives (commit, file path, task ID).",
      }),
    ),
    nextAction: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: FIELD_LIMITS.nextAction,
        description: "note only, optional: what a resuming session should do next.",
      }),
    ),
    reviewed: Type.Optional(
      Type.Boolean({
        description:
          "done only, optional: true only when a human or coordinator has reviewed and accepted the result. Defaults to false.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface SpoolServiceLike {
  attach(input: {
    vault: string;
    taskId: string;
    canonicalPath: string;
    outcome?: string;
  }): Promise<WorkRecord>;
  reconcileBinding(binding: SessionBinding): Promise<WorkRecord>;
  resume(binding: SessionBinding, identity: RuntimeIdentity): Promise<ResumePacket>;
  overview(identity: RuntimeIdentity): Promise<OverviewPacket>;
  peek(
    reference: { taskId: string; vault?: string },
    identity: RuntimeIdentity,
  ): Promise<ResumePacket>;
  note(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: {
      stepId: string;
      title?: string;
      summary: string;
      evidenceRef?: string;
      nextAction?: string;
    },
  ): Promise<RecordResult>;
  done(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: {
      stepId: string;
      summary: string;
      evidenceRef?: string;
      reviewed?: boolean;
    },
  ): Promise<RecordResult>;
  close(): Promise<void>;
}

export interface SpoolExtensionDependencies {
  env?: Record<string, string | undefined>;
  agentDir?: string;
  runtimeId?: string;
  createService?: (config: SpoolConfig) => SpoolServiceLike;
  createDashboardReader?: (config: SpoolConfig) => DashboardReaderLike;
  createPkmReferenceReader?: () => PkmReferenceReaderLike;
  readTaskReference?: typeof readCanonicalTaskReference;
}

export function extractRuntimeIdentity(
  ctx: Pick<ExtensionContext, "sessionManager">,
  pi: Pick<ExtensionAPI, "getSessionName">,
  runtimeId: string,
): RuntimeIdentity {
  return {
    piSessionId: ctx.sessionManager.getSessionId(),
    piSessionName: pi.getSessionName() ?? null,
    piSessionFile: ctx.sessionManager.getSessionFile() ?? null,
    runtimeId,
  };
}

export const SPOOL_PROMPT_GUIDELINES = [
  "spool is a work log, not a gate. It never authorizes or blocks work; keep attention on the goal and log only what a later session would need.",
  "At the start of work on a PKM task, call spool resume with the task file's canonicalPath. Read the current step and next action, then continue the work. With no attached goal, spool resume lists every goal and where it stands; use taskId to look at one without attaching.",
  "Record a spool note when a step starts, at a meaningful milestone, or before stopping; include a nextAction so the next session knows where to pick up. Do not log routine tool calls or reasoning.",
  "Call spool done when a step's work is finished. Leave reviewed false unless a human or coordinator has accepted the result.",
  "A warning in a spool result is information about other sessions, not an error. Mention it once and carry on.",
] as const;

export function registerSpoolExtension(
  pi: ExtensionAPI,
  dependencies: SpoolExtensionDependencies = {},
): void {
  const runtimeId = dependencies.runtimeId ?? randomUUID();
  const readTask = dependencies.readTaskReference ?? readCanonicalTaskReference;
  let binding: SessionBinding | null = null;
  let service: SpoolServiceLike | null = null;
  let operationTail: Promise<void> = Promise.resolve();

  const getService = (): SpoolServiceLike => {
    if (service) return service;
    const config = readSpoolConfig(
      dependencies.env ?? process.env,
      dependencies.agentDir ?? getAgentDir(),
    );
    service = dependencies.createService
      ? dependencies.createService(config)
      : SpoolService.connect(config);
    return service;
  };

  const requireBinding = async (): Promise<SessionBinding> => {
    if (!binding) {
      throw new Error(
        "this session has no attached goal; call spool resume with the task file's canonicalPath first",
      );
    }
    const captured = { ...binding };
    await getService().reconcileBinding(captured);
    return captured;
  };

  const enqueueOperation = <T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const queued = operationTail.then(async () => {
      if (signal?.aborted) throw new Error("spool operation cancelled while queued");
      return await operation();
    });
    operationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  const persistBinding = (next: SessionBinding): void => {
    binding = next;
    pi.appendEntry(SPOOL_BINDING_ENTRY, next);
  };

  pi.registerCommand("spool", {
    description: "Browse the Spool work log",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const message = "/spool requires interactive Pi TUI mode";
        if (ctx.hasUI) {
          ctx.ui.notify(message, "error");
          return;
        }
        throw new Error(message);
      }
      let reader: DashboardReaderLike | undefined;
      try {
        const config = readSpoolConfig(
          dependencies.env ?? process.env,
          dependencies.agentDir ?? getAgentDir(),
        );
        reader = dependencies.createDashboardReader
          ? dependencies.createDashboardReader(config)
          : SpoolDashboardReader.connect(config);
        await runSpoolDashboard(
          ctx,
          reader,
          extractRuntimeIdentity(ctx, pi, runtimeId),
          dependencies.createPkmReferenceReader?.() ?? new PkmReferenceReader(),
        );
      } catch (error) {
        ctx.ui.notify(spoolUserFacingError(error).message, "error");
      } finally {
        if (reader) {
          await reader.close().catch((error: unknown) => {
            ctx.ui.notify(spoolUserFacingError(error).message, "error");
          });
        }
      }
    },
  });

  pi.registerTool({
    name: "spool",
    label: "Spool",
    description:
      "Work log for a PKM goal across Pi sessions. resume shows where the goal stands (pass canonicalPath once per session to attach). note records progress on a step. done marks a step finished. Never blocks work; warnings are advisory.",
    promptSnippet: "Log progress on a PKM goal so a later session can resume it",
    promptGuidelines: [...SPOOL_PROMPT_GUIDELINES],
    parameters: spoolParameters,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("spool operation cancelled");
      const input = parseSpoolToolInput(rawParams);
      const identity = extractRuntimeIdentity(ctx, pi, runtimeId);
      return await enqueueOperation(signal, async () => {
        try {
          const result = await executeAction(input, identity);
          return {
            content: [{ type: "text" as const, text: renderSpoolResult(input.action, result) }],
            details: result,
          };
        } catch (error) {
          throw spoolUserFacingError(error);
        }
      });
    },
  });

  const restoreBranchBinding = async (ctx: ExtensionContext): Promise<void> => {
    await enqueueOperation(undefined, async () => {
      binding = restoreBinding(ctx.sessionManager.getBranch());
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    await restoreBranchBinding(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restoreBranchBinding(ctx);
  });
  pi.on("session_shutdown", async () => {
    await operationTail;
    const current = service;
    service = null;
    await current?.close();
  });

  async function executeAction(
    input: SpoolToolInput,
    identity: RuntimeIdentity,
  ): Promise<Record<string, unknown>> {
    switch (input.action) {
      case "resume": {
        if (input.taskId) {
          return {
            ...(await getService().peek({ taskId: input.taskId, vault: input.vault }, identity)),
            attached: false,
          };
        }
        if (input.scope === "all" || (!input.canonicalPath && !binding)) {
          return { ...(await getService().overview(identity)) };
        }
        if (input.canonicalPath) {
          const reference = await readTask({
            canonicalPath: input.canonicalPath,
            vault: input.vault,
          });
          const work = await getService().attach({
            vault: reference.vault,
            taskId: reference.taskId,
            canonicalPath: reference.canonicalPath,
            outcome: input.outcome ?? reference.title ?? undefined,
          });
          persistBinding({
            version: 1,
            workId: work.workId,
            vault: work.vault,
            taskId: work.taskId,
            canonicalPath: work.canonicalPath,
          });
        }
        const current = await requireBinding();
        return { ...(await getService().resume(current, identity)) };
      }
      case "note": {
        const current = await requireBinding();
        return { ...(await getService().note(current, identity, input)) };
      }
      case "done": {
        const current = await requireBinding();
        return { ...(await getService().done(current, identity, input)) };
      }
    }
  }
}

export const MAX_TOOL_OUTPUT_BYTES = 8_000;

export function renderSpoolResult(
  action: string,
  result: Record<string, unknown>,
): string {
  const rendered = `Spool ${action}:\n${JSON.stringify(result)}`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    throw new Error("Spool output bound invariant failed");
  }
  return rendered;
}

export default registerSpoolExtension;
