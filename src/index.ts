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
  restoreBinding,
  validateCanonicalTaskReference,
  type SessionBinding,
} from "./binding.ts";
import { readSpoolConfig, type SpoolConfig } from "./config.ts";
import {
  SpoolService,
  spoolUserFacingError,
  type ClaimedAttempt,
  type ResumePacket,
  type RuntimeIdentity,
  type StepDefinition,
  type WorkRecord,
} from "./spool-service.ts";
import {
  SPOOL_ACTIONS,
  parseSpoolToolInput,
  type SpoolToolInput,
} from "./tool-contract.ts";

const stableIdentifierPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";

export const spoolParameters = Type.Object(
  {
    action: StringEnum([...SPOOL_ACTIONS], {
      description:
        "Operation and field map: attach requires vault, taskId, canonicalPath, outcome; materialize requires stepId, title, contribution, criteria; claim allows expectedStepId and leaseSeconds; checkpoint requires checkpointName and evidenceRef and allows nextAction; heartbeat allows leaseSeconds; status/resume accept no other fields; complete requires resultRef and summary (not outcome).",
    }),
    vault: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: "Attach only (required): non-empty, max 100 characters.",
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        description: "Attach only (required): non-empty, max 100 characters.",
      }),
    ),
    canonicalPath: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2_000,
        description: "Attach only (required): non-empty, max 2000 characters.",
      }),
    ),
    outcome: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description:
          "Attach only (required): non-empty, max 500 characters; never pass to complete.",
      }),
    ),
    stepId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        pattern: stableIdentifierPattern,
        description:
          "Materialize only (required): max 100 characters; start alphanumeric, then letters, digits, ., _, :, or -.",
      }),
    ),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Materialize only (required): non-empty, max 200 characters.",
      }),
    ),
    contribution: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Materialize only (required): non-empty, max 500 characters.",
      }),
    ),
    criteria: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Materialize only (required): non-empty, max 500 characters.",
      }),
    ),
    expectedStepId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        pattern: stableIdentifierPattern,
        description:
          "Claim only (optional): max 100 characters; start alphanumeric, then letters, digits, ., _, :, or -.",
      }),
    ),
    leaseSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3_600,
        description: "Optional for claim or heartbeat; rejected otherwise.",
      }),
    ),
    checkpointName: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
        pattern: stableIdentifierPattern,
        description:
          "Checkpoint only (required): max 100 characters; start alphanumeric, then letters, digits, ., _, :, or -.",
      }),
    ),
    evidenceRef: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1_000,
        description: "Checkpoint only (required): non-empty, max 1000 characters.",
      }),
    ),
    nextAction: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description: "Checkpoint only (optional): non-empty, max 500 characters.",
      }),
    ),
    resultRef: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1_000,
        description: "Complete only (required): non-empty, max 1000 characters.",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        description:
          "Complete only (required execution summary): non-empty, max 500 characters.",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface SpoolServiceLike {
  attach(
    input: {
      vault: string;
      taskId: string;
      canonicalPath: string;
      outcome: string;
    },
    identity: RuntimeIdentity,
  ): Promise<WorkRecord>;
  reconcileBinding(binding: SessionBinding): Promise<WorkRecord>;
  materialize(
    binding: SessionBinding,
    definition: StepDefinition,
  ): Promise<{ stepId: string; taskId: string; created: boolean }>;
  claimNext(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    options: { expectedStepId?: string; leaseSeconds: number },
  ): Promise<ClaimedAttempt | null>;
  checkpoint(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: { checkpointName: string; evidenceRef: string; nextAction?: string },
  ): Promise<void>;
  heartbeat(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    leaseSeconds: number,
  ): Promise<Date>;
  completeExecution(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: { resultRef: string; summary: string },
  ): Promise<void>;
  resume(binding: SessionBinding, identity: RuntimeIdentity): Promise<ResumePacket>;
  close(): Promise<void>;
}

export interface SpoolExtensionDependencies {
  env?: Record<string, string | undefined>;
  agentDir?: string;
  runtimeId?: string;
  createService?: (config: SpoolConfig) => SpoolServiceLike;
  validateTaskReference?: typeof validateCanonicalTaskReference;
}

export function extractRuntimeIdentity(
  ctx: Pick<ExtensionContext, "sessionManager">,
  pi: Pick<ExtensionAPI, "getSessionName">,
  runtimeId: string,
): RuntimeIdentity {
  return {
    piSessionId: ctx.sessionManager.getSessionId(),
    piSessionName: pi.getSessionName(),
    piSessionFile: ctx.sessionManager.getSessionFile(),
    runtimeId,
  };
}

export function registerSpoolExtension(
  pi: ExtensionAPI,
  dependencies: SpoolExtensionDependencies = {},
): void {
  const runtimeId = dependencies.runtimeId ?? randomUUID();
  const validateTask =
    dependencies.validateTaskReference ?? validateCanonicalTaskReference;
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
      throw new Error("this session is not attached; call spool action=attach first");
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

  pi.registerTool({
    name: "spool",
    label: "Spool",
    description:
      "Attach a canonical PKM goal and durably materialize, claim, checkpoint, inspect, resume, heartbeat, or execution-complete one consequential step. Fields are action-specific: complete requires summary and resultRef, never outcome. Checkpoints are not reviewed acceptance.",
    promptSnippet:
      "Durably attach and continue consequential work across Pi sessions",
    promptGuidelines: [
      "Use spool only for consequential work that a later turn/session depends on, a durable wait, or an effect expensive to repeat; do not record private reasoning, routine tool calls, or micro-steps.",
      "Before spool mutations, attach the explicit canonical goal, inspect durable state, claim within current ownership, and stop on lost ownership, storage failure, or uncertain external side effects.",
      "Spool execution completion is not reviewed evidence acceptance; explain that distinction when reporting results.",
    ],
    parameters: spoolParameters,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("spool operation cancelled");
      const input = parseSpoolToolInput(rawParams);
      const identity = extractRuntimeIdentity(ctx, pi, runtimeId);
      return await enqueueOperation(signal, async () => {
        try {
          const result = await executeAction(input, identity);
          return {
            content: [
              {
                type: "text" as const,
                text: renderSpoolResult(input.action, result),
              },
            ],
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
      // Restore lineage only. Durable reconciliation is lazy and mandatory
      // before use; branch entries never restore lease authority.
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
      case "attach": {
        const reference = await validateTask(input);
        const work = await getService().attach(
          { ...reference, outcome: input.outcome },
          identity,
        );
        persistBinding({
          version: 1,
          workId: work.workId,
          vault: work.vault,
          taskId: work.taskId,
          canonicalPath: work.canonicalPath,
        });
        return { attached: true, goal: work, acceptance: "not_recorded" };
      }
      case "materialize": {
        const current = await requireBinding();
        const step = await getService().materialize(current, input);
        persistBinding({ ...current, stepId: input.stepId });
        return { materialized: true, ...step };
      }
      case "claim": {
        const current = await requireBinding();
        const attempt = await getService().claimNext(current, identity, input);
        if (!attempt) {
          return {
            claimed: false,
            reason: "no ready queue item; inspect status and do not assume ownership",
          };
        }
        persistBinding({ ...current, stepId: attempt.stepId });
        return { claimed: true, attempt };
      }
      case "checkpoint": {
        const current = await requireBinding();
        await getService().checkpoint(current, identity, input);
        return {
          checkpointed: true,
          checkpointName: input.checkpointName,
          evidenceRef: input.evidenceRef,
          accepted: false,
        };
      }
      case "heartbeat": {
        const current = await requireBinding();
        const leaseExpiresAt = await getService().heartbeat(
          current,
          identity,
          input.leaseSeconds,
        );
        return { renewed: true, leaseExpiresAt };
      }
      case "status":
      case "resume": {
        const current = await requireBinding();
        return {
          mode: input.action,
          packet: await getService().resume(current, identity),
        };
      }
      case "complete": {
        const current = await requireBinding();
        await getService().completeExecution(current, identity, input);
        return {
          executionCompleted: true,
          resultRef: input.resultRef,
          acceptance: "not_recorded",
        };
      }
    }
  }
}

export const MAX_TOOL_OUTPUT_BYTES = 16_000;

export function renderSpoolResult(
  action: string,
  result: Record<string, unknown>,
): string {
  const suffix =
    action === "complete"
      ? "\nExecution is complete; reviewed acceptance is not recorded."
      : "";
  const rendered = `Spool ${action}:\n${JSON.stringify(result)}${suffix}`;
  if (Buffer.byteLength(rendered, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    throw new Error("Spool output bound invariant failed; inspect with a narrower query");
  }
  return rendered;
}

export default registerSpoolExtension;
