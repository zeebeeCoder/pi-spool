export const SPOOL_ACTIONS = [
  "attach",
  "materialize",
  "claim",
  "checkpoint",
  "heartbeat",
  "status",
  "resume",
  "complete",
] as const;

export type SpoolAction = (typeof SPOOL_ACTIONS)[number];

export type SpoolToolInput =
  | {
      action: "attach";
      vault: string;
      taskId: string;
      canonicalPath: string;
      outcome: string;
    }
  | {
      action: "materialize";
      stepId: string;
      title: string;
      contribution: string;
      criteria: string;
    }
  | { action: "claim"; expectedStepId?: string; leaseSeconds: number }
  | {
      action: "checkpoint";
      checkpointName: string;
      evidenceRef: string;
      nextAction?: string;
    }
  | { action: "heartbeat"; leaseSeconds: number }
  | { action: "status" }
  | { action: "resume" }
  | { action: "complete"; resultRef: string; summary: string };

const fieldsByAction: Record<SpoolAction, readonly string[]> = {
  attach: ["action", "vault", "taskId", "canonicalPath", "outcome"],
  materialize: ["action", "stepId", "title", "contribution", "criteria"],
  claim: ["action", "expectedStepId", "leaseSeconds"],
  checkpoint: ["action", "checkpointName", "evidenceRef", "nextAction"],
  heartbeat: ["action", "leaseSeconds"],
  status: ["action"],
  resume: ["action"],
  complete: ["action", "resultRef", "summary"],
};

export function parseSpoolToolInput(value: unknown): SpoolToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("spool input must be an object");
  }
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (typeof action !== "string" || !SPOOL_ACTIONS.includes(action as SpoolAction)) {
    throw new Error(`unsupported spool action: ${String(action)}`);
  }

  const typedAction = action as SpoolAction;
  const allowed = new Set(fieldsByAction[typedAction]);
  const unexpected = Object.keys(input).find(
    (key) => input[key] !== undefined && !allowed.has(key),
  );
  if (unexpected) {
    throw new Error(`${typedAction} does not accept ${unexpected}`);
  }

  switch (typedAction) {
    case "attach":
      return {
        action: typedAction,
        vault: requiredString(input, "vault", 100),
        taskId: requiredString(input, "taskId", 100),
        canonicalPath: requiredString(input, "canonicalPath", 2_000),
        outcome: requiredString(input, "outcome", 500),
      };
    case "materialize":
      return {
        action: typedAction,
        stepId: stableId(input, "stepId"),
        title: requiredString(input, "title", 200),
        contribution: requiredString(input, "contribution", 500),
        criteria: requiredString(input, "criteria", 500),
      };
    case "claim":
      return {
        action: typedAction,
        expectedStepId: optionalStableId(input, "expectedStepId"),
        leaseSeconds: leaseSeconds(input, 30),
      };
    case "checkpoint":
      return {
        action: typedAction,
        checkpointName: stableId(input, "checkpointName"),
        evidenceRef: requiredString(input, "evidenceRef", 1_000),
        nextAction: optionalString(input, "nextAction", 500),
      };
    case "heartbeat":
      return {
        action: typedAction,
        leaseSeconds: leaseSeconds(input, 30),
      };
    case "status":
    case "resume":
      return { action: typedAction };
    case "complete":
      return {
        action: typedAction,
        resultRef: requiredString(input, "resultRef", 1_000),
        summary: requiredString(input, "summary", 500),
      };
  }
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${key} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  return input[key] === undefined ? undefined : requiredString(input, key, maxLength);
}

function stableId(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${key} must be a stable identifier using letters, digits, . _ : or -`);
  }
  return value;
}

function optionalStableId(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  return input[key] === undefined ? undefined : stableId(input, key);
}

function leaseSeconds(input: Record<string, unknown>, fallback: number): number {
  const value = input.leaseSeconds ?? fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 3_600) {
    throw new Error("leaseSeconds must be an integer from 1 to 3600");
  }
  return value as number;
}
