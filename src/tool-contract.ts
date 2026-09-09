export const SPOOL_ACTIONS = ["resume", "note", "done"] as const;

export type SpoolAction = (typeof SPOOL_ACTIONS)[number];

export type SpoolToolInput =
  | {
      action: "resume";
      canonicalPath?: string;
      vault?: string;
      outcome?: string;
      taskId?: string;
      scope?: "goal" | "all";
    }
  | {
      action: "note";
      stepId: string;
      title?: string;
      summary: string;
      evidenceRef?: string;
      nextAction?: string;
    }
  | {
      action: "done";
      stepId: string;
      summary: string;
      evidenceRef?: string;
      reviewed?: boolean;
    };

export const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const FIELD_LIMITS = {
  canonicalPath: 2_000,
  vault: 100,
  outcome: 500,
  taskId: 100,
  stepId: 100,
  title: 200,
  summary: 500,
  evidenceRef: 1_000,
  nextAction: 500,
} as const;

const fieldsByAction: Record<SpoolAction, readonly string[]> = {
  resume: ["action", "canonicalPath", "vault", "outcome", "taskId", "scope"],
  note: ["action", "stepId", "title", "summary", "evidenceRef", "nextAction"],
  done: ["action", "stepId", "summary", "evidenceRef", "reviewed"],
};

const requiredByAction: Record<SpoolAction, readonly string[]> = {
  resume: [],
  note: ["stepId", "summary"],
  done: ["stepId", "summary"],
};

export function parseSpoolToolInput(value: unknown): SpoolToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("spool input must be an object");
  }
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (typeof action !== "string" || !SPOOL_ACTIONS.includes(action as SpoolAction)) {
    throw new Error(
      `unsupported spool action: ${String(action)}; use resume, note, or done`,
    );
  }
  const typed = action as SpoolAction;
  const allowed = new Set(fieldsByAction[typed]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`field ${key} is not accepted by spool action ${typed}`);
    }
  }
  for (const key of requiredByAction[typed]) {
    if (input[key] === undefined) {
      throw new Error(`spool action ${typed} requires ${key}`);
    }
  }
  for (const [key, limit] of Object.entries(FIELD_LIMITS)) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || field.trim().length === 0) {
      throw new Error(`${key} must be a non-empty string`);
    }
    if (field.length > limit) {
      throw new Error(`${key} exceeds ${limit} characters`);
    }
  }
  if (input.reviewed !== undefined && typeof input.reviewed !== "boolean") {
    throw new Error("reviewed must be a boolean");
  }
  if (input.scope !== undefined && input.scope !== "goal" && input.scope !== "all") {
    throw new Error("scope must be goal or all");
  }
  if (input.canonicalPath !== undefined && input.taskId !== undefined) {
    throw new Error("pass either canonicalPath (attach) or taskId (peek), not both");
  }
  if (typeof input.stepId === "string" && !STEP_ID_PATTERN.test(input.stepId)) {
    throw new Error(
      "stepId must start with a letter or digit and contain only letters, digits, ., _, :, or -",
    );
  }
  return input as SpoolToolInput;
}
