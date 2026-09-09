import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { SessionBinding } from "./binding.ts";
import type { SpoolConfig } from "./config.ts";

export const MAX_RESUME_STEPS = 12;
export const MAX_OVERVIEW_GOALS = 20;
export const MAX_RESUME_TEXT_CHARS = 240;
export const MAX_RESUME_PACKET_BYTES = 6_000;
export const PEER_ACTIVITY_WINDOW_MINUTES = 60;

export const SPOOL_CONNECTION_TIMEOUT_MS = 3_000;
export const SPOOL_STATEMENT_TIMEOUT_MS = 10_000;
export const SPOOL_QUERY_TIMEOUT_MS = 12_000;
export const SPOOL_CLOSE_TIMEOUT_MS = 15_000;

export interface RuntimeIdentity {
  piSessionId: string;
  piSessionName: string | null;
  piSessionFile: string | null;
  runtimeId: string;
}

export interface WorkRecord {
  workId: string;
  vault: string;
  taskId: string;
  canonicalPath: string;
  outcome: string;
}

export type EventKind = "note" | "done";

export interface StepEvent {
  kind: EventKind;
  summary: string;
  evidenceRef: string | null;
  nextAction: string | null;
  reviewed: boolean;
  session: string;
  mine: boolean;
  recordedAt: string;
}

export interface ResumeStep {
  stepId: string;
  title: string;
  state: "open" | "done";
  reviewed: boolean;
  last: StepEvent;
}

export interface ResumePacket {
  goal: WorkRecord;
  current: string | null;
  nextAction: string | null;
  steps: ResumeStep[];
  omittedSteps: number;
}

export interface OverviewGoal {
  vault: string;
  taskId: string;
  canonicalPath: string;
  outcome: string;
  openSteps: number;
  doneSteps: number;
  sessions: number;
  lastActivityAt: string;
  current: {
    stepId: string;
    title: string;
    summary: string;
    nextAction: string | null;
    session: string;
    mine: boolean;
    recordedAt: string;
  } | null;
}

export interface OverviewPacket {
  scope: "all";
  goals: OverviewGoal[];
  omittedGoals: number;
}

export interface RecordResult {
  recorded: EventKind;
  stepId: string;
  created: boolean;
  recordedAt: string;
  warning: string | null;
}

export class SpoolDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpoolDatabaseError";
  }
}

export function createBoundedSpoolPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: SPOOL_CONNECTION_TIMEOUT_MS,
    statement_timeout: SPOOL_STATEMENT_TIMEOUT_MS,
    query_timeout: SPOOL_QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: SPOOL_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: SPOOL_STATEMENT_TIMEOUT_MS,
  });
  // Idle-client failures arrive as EventEmitter errors; the next explicit
  // operation reports a sanitized error instead of crashing Pi.
  pool.on("error", () => undefined);
  return pool;
}

export async function closeBoundedSpoolPool(pool: Pool): Promise<void> {
  await withDeadline(
    pool.end(),
    SPOOL_CLOSE_TIMEOUT_MS,
    "Timed out closing the Spool database pool; process exit will release remaining sockets",
  );
}

interface WorkRow {
  work_id: string;
  vault: string;
  pkm_task_id: string;
  canonical_path: string;
  outcome: string;
}

interface EventRow {
  kind: EventKind;
  summary: string;
  evidence_ref: string | null;
  next_action: string | null;
  reviewed: boolean;
  pi_session_id: string;
  pi_session_name: string | null;
  recorded_at: Date;
}

interface StepRow extends EventRow {
  step_id: string;
  title: string;
  total_steps: string;
}

/**
 * Thin append-only work log. Every mutation is one short transaction that
 * appends an event; nothing here can refuse work on behalf of another session.
 */
export class SpoolService {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private closed = false;

  constructor(pool: Pool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  static connect(config: SpoolConfig): SpoolService {
    return new SpoolService(createBoundedSpoolPool(config.databaseUrl), true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.ownsPool) return;
    await closeBoundedSpoolPool(this.pool);
  }

  /** Creates or refreshes the goal record for one PKM task. */
  async attach(input: {
    vault: string;
    taskId: string;
    canonicalPath: string;
    outcome?: string;
  }): Promise<WorkRecord> {
    return await this.transaction(async (client) => {
      const workId = deriveWorkId(input);
      const row = await client.query<WorkRow>(
        `INSERT INTO spool.works (work_id, vault, pkm_task_id, canonical_path, outcome)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vault, pkm_task_id) DO UPDATE
            SET canonical_path = EXCLUDED.canonical_path,
                outcome = CASE WHEN EXCLUDED.outcome <> '' THEN EXCLUDED.outcome
                               ELSE spool.works.outcome END,
                updated_at = now()
         RETURNING work_id, vault, pkm_task_id, canonical_path, outcome`,
        [workId, input.vault, input.taskId, input.canonicalPath, input.outcome ?? ""],
      );
      return mapWork(row.rows[0]!);
    });
  }

  async reconcileBinding(binding: SessionBinding): Promise<WorkRecord> {
    const row = await this.query<WorkRow>(
      `SELECT work_id, vault, pkm_task_id, canonical_path, outcome
         FROM spool.works WHERE work_id = $1`,
      [binding.workId],
    );
    const work = row.rows[0];
    if (!work) {
      throw new Error(
        `attached goal ${binding.vault}/${binding.taskId} is no longer recorded; call spool resume with canonicalPath to re-attach`,
      );
    }
    return mapWork(work);
  }

  async resume(binding: SessionBinding, identity: RuntimeIdentity): Promise<ResumePacket> {
    const work = await this.reconcileBinding(binding);
    const rows = await this.query<StepRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (e.step_id) e.*
           FROM spool.events e
          WHERE e.work_id = $1
          ORDER BY e.step_id, e.recorded_at DESC, e.seq DESC
       )
       SELECT s.step_id, s.title, l.kind, l.summary, l.evidence_ref, l.next_action,
              l.reviewed, l.pi_session_id, l.pi_session_name, l.recorded_at,
              count(*) OVER ()::text AS total_steps
         FROM spool.steps s
         JOIN latest l ON l.step_id = s.step_id
        WHERE s.work_id = $1
        ORDER BY (l.kind = 'done'), l.recorded_at DESC, s.step_id
        LIMIT $2`,
      [work.workId, MAX_RESUME_STEPS],
    );
    const mine = await this.query<{ step_id: string; kind: EventKind }>(
      `SELECT step_id, kind FROM spool.events
        WHERE work_id = $1 AND pi_session_id = $2
        ORDER BY recorded_at DESC, seq DESC LIMIT 1`,
      [work.workId, identity.piSessionId],
    );
    const steps = rows.rows.map((row) => ({
      stepId: row.step_id,
      title: row.title,
      state: row.kind === "done" ? ("done" as const) : ("open" as const),
      reviewed: row.kind === "done" && row.reviewed,
      last: mapEvent(row, identity),
    }));
    const total = Number(rows.rows[0]?.total_steps ?? 0);
    const myLast = mine.rows[0];
    const current =
      myLast && myLast.kind !== "done" && steps.some((s) => s.stepId === myLast.step_id)
        ? myLast.step_id
        : steps.find((s) => s.state === "open")?.stepId ?? null;
    const currentStep = steps.find((s) => s.stepId === current);
    return boundResumePacket({
      goal: work,
      current,
      nextAction:
        currentStep?.last.nextAction ??
        (currentStep ? `Continue step ${currentStep.stepId}` : null) ??
        (steps.length === 0 ? "Record a note for the first step" : "All recorded steps are done"),
      steps,
      omittedSteps: Math.max(0, total - steps.length),
    });
  }

  /** Read-only view of another goal by task ID; does not touch the session binding. */
  async peek(
    reference: { taskId: string; vault?: string },
    identity: RuntimeIdentity,
  ): Promise<ResumePacket> {
    const rows = await this.query<WorkRow>(
      `SELECT work_id, vault, pkm_task_id, canonical_path, outcome
         FROM spool.works
        WHERE pkm_task_id = $1 AND ($2::text IS NULL OR vault = $2)
        ORDER BY updated_at DESC`,
      [reference.taskId, reference.vault ?? null],
    );
    if (rows.rows.length === 0) {
      throw new Error(`no recorded goal for task ${reference.taskId}; nothing has been logged for it`);
    }
    if (rows.rows.length > 1) {
      throw new Error(
        `task ${reference.taskId} exists in ${rows.rows.map((r) => r.vault).join(", ")}; pass vault`,
      );
    }
    const work = mapWork(rows.rows[0]!);
    return await this.resume(
      { version: 1, workId: work.workId, vault: work.vault, taskId: work.taskId, canonicalPath: work.canonicalPath },
      identity,
    );
  }

  /** Every goal with counts and its current open step, newest activity first. */
  async overview(identity: RuntimeIdentity): Promise<OverviewPacket> {
    const rows = await this.query<{
      work_id: string;
      vault: string;
      pkm_task_id: string;
      canonical_path: string;
      outcome: string;
      open_steps: string;
      done_steps: string;
      sessions: string;
      last_activity_at: Date;
      total_goals: string;
      step_id: string | null;
      title: string | null;
      summary: string | null;
      next_action: string | null;
      pi_session_id: string | null;
      pi_session_name: string | null;
      recorded_at: Date | null;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (work_id, step_id) *
           FROM spool.events
          ORDER BY work_id, step_id, recorded_at DESC, seq DESC
       ),
       per_work AS (
         SELECT w.work_id,
                count(l.*) FILTER (WHERE l.kind = 'note') AS open_steps,
                count(l.*) FILTER (WHERE l.kind = 'done') AS done_steps,
                count(DISTINCT l.pi_session_id) AS sessions,
                greatest(w.updated_at, max(l.recorded_at)) AS last_activity_at
           FROM spool.works w
           LEFT JOIN latest l ON l.work_id = w.work_id
          GROUP BY w.work_id, w.updated_at
       ),
       current_step AS (
         SELECT DISTINCT ON (l.work_id) l.work_id, l.step_id, s.title, l.summary,
                l.next_action, l.pi_session_id, l.pi_session_name, l.recorded_at
           FROM latest l
           JOIN spool.steps s ON s.work_id = l.work_id AND s.step_id = l.step_id
          WHERE l.kind = 'note'
          ORDER BY l.work_id, l.recorded_at DESC
       )
       SELECT w.work_id, w.vault, w.pkm_task_id, w.canonical_path, w.outcome,
              pw.open_steps::text, pw.done_steps::text, pw.sessions::text, pw.last_activity_at,
              count(*) OVER ()::text AS total_goals,
              c.step_id, c.title, c.summary, c.next_action,
              c.pi_session_id, c.pi_session_name, c.recorded_at
         FROM spool.works w
         JOIN per_work pw ON pw.work_id = w.work_id
         LEFT JOIN current_step c ON c.work_id = w.work_id
        ORDER BY pw.last_activity_at DESC, w.work_id
        LIMIT $1`,
      [MAX_OVERVIEW_GOALS],
    );
    const goals: OverviewGoal[] = rows.rows.map((row) => ({
      vault: row.vault,
      taskId: row.pkm_task_id,
      canonicalPath: row.canonical_path,
      outcome: truncate(row.outcome, 140),
      openSteps: Number(row.open_steps),
      doneSteps: Number(row.done_steps),
      sessions: Number(row.sessions),
      lastActivityAt: row.last_activity_at.toISOString(),
      current:
        row.step_id && row.title && row.summary && row.pi_session_id && row.recorded_at
          ? {
              stepId: row.step_id,
              title: truncate(row.title, 120),
              summary: truncate(row.summary, 160),
              nextAction: row.next_action ? truncate(row.next_action, 160) : null,
              session: row.pi_session_name ?? shortId(row.pi_session_id),
              mine: row.pi_session_id === identity.piSessionId,
              recordedAt: row.recorded_at.toISOString(),
            }
          : null,
    }));
    const total = Number(rows.rows[0]?.total_goals ?? 0);
    const packet: OverviewPacket = {
      scope: "all",
      goals,
      omittedGoals: Math.max(0, total - goals.length),
    };
    while (
      Buffer.byteLength(JSON.stringify(packet), "utf8") > MAX_RESUME_PACKET_BYTES &&
      packet.goals.length > 1
    ) {
      packet.goals.pop();
      packet.omittedGoals += 1;
    }
    return packet;
  }

  async note(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: {
      stepId: string;
      title?: string;
      summary: string;
      evidenceRef?: string;
      nextAction?: string;
    },
  ): Promise<RecordResult> {
    return await this.append(binding, identity, {
      kind: "note",
      stepId: input.stepId,
      title: input.title,
      summary: input.summary,
      evidenceRef: input.evidenceRef ?? null,
      nextAction: input.nextAction ?? null,
      reviewed: false,
    });
  }

  async done(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: { stepId: string; summary: string; evidenceRef?: string; reviewed?: boolean },
  ): Promise<RecordResult> {
    return await this.append(binding, identity, {
      kind: "done",
      stepId: input.stepId,
      summary: input.summary,
      evidenceRef: input.evidenceRef ?? null,
      nextAction: null,
      reviewed: input.reviewed ?? false,
    });
  }

  private async append(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    event: {
      kind: EventKind;
      stepId: string;
      title?: string;
      summary: string;
      evidenceRef: string | null;
      nextAction: string | null;
      reviewed: boolean;
    },
  ): Promise<RecordResult> {
    return await this.transaction(async (client) => {
      const work = await client.query<{ work_id: string }>(
        "SELECT work_id FROM spool.works WHERE work_id = $1",
        [binding.workId],
      );
      if (work.rows.length === 0) {
        throw new Error(
          `attached goal ${binding.vault}/${binding.taskId} is no longer recorded; call spool resume with canonicalPath to re-attach`,
        );
      }
      const inserted = await client.query<{ step_id: string }>(
        `INSERT INTO spool.steps (work_id, step_id, title)
         VALUES ($1, $2, $3)
         ON CONFLICT (work_id, step_id) DO NOTHING
         RETURNING step_id`,
        [binding.workId, event.stepId, event.title ?? event.stepId],
      );
      const created = inserted.rows.length > 0;
      const warning = created
        ? null
        : await this.peerWarning(client, binding.workId, event, identity);
      const recorded = await client.query<{ recorded_at: Date }>(
        `INSERT INTO spool.events
           (event_id, work_id, step_id, kind, summary, evidence_ref, next_action,
            reviewed, pi_session_id, pi_session_name, pi_session_file, runtime_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING recorded_at`,
        [
          randomUUID(),
          binding.workId,
          event.stepId,
          event.kind,
          event.summary,
          event.evidenceRef,
          event.nextAction,
          event.reviewed,
          identity.piSessionId,
          identity.piSessionName,
          identity.piSessionFile,
          identity.runtimeId,
        ],
      );
      return {
        recorded: event.kind,
        stepId: event.stepId,
        created,
        recordedAt: recorded.rows[0]!.recorded_at.toISOString(),
        warning,
      };
    });
  }

  /** Advisory only: tells the caller what other sessions did on this step recently. */
  private async peerWarning(
    client: PoolClient,
    workId: string,
    event: { kind: EventKind; stepId: string },
    identity: RuntimeIdentity,
  ): Promise<string | null> {
    const last = await client.query<EventRow & { minutes_ago: number }>(
      `SELECT kind, summary, evidence_ref, next_action, reviewed,
              pi_session_id, pi_session_name, recorded_at,
              extract(epoch FROM (now() - recorded_at)) / 60 AS minutes_ago
         FROM spool.events
        WHERE work_id = $1 AND step_id = $2
        ORDER BY recorded_at DESC, seq DESC LIMIT 1`,
      [workId, event.stepId],
    );
    const row = last.rows[0];
    if (!row) return null;
    const who = row.pi_session_name ?? shortId(row.pi_session_id);
    const ago = `${Math.max(0, Math.round(Number(row.minutes_ago)))}m ago`;
    if (row.kind === "done") {
      return event.kind === "done"
        ? `step was already marked done ${ago} by ${who}; recorded again`
        : `step was marked done ${ago} by ${who}; this note reopens it`;
    }
    if (
      row.pi_session_id !== identity.piSessionId &&
      Number(row.minutes_ago) <= PEER_ACTIVITY_WINDOW_MINUTES
    ) {
      return `${who} noted this step ${ago}: ${truncate(row.summary, 160)}`;
    }
    return null;
  }

  private async query<T extends QueryResultRow>(
    text: string,
    values: unknown[],
  ): Promise<{ rows: T[] }> {
    try {
      return await this.pool.query<T>(text, values);
    } catch (error) {
      throw spoolUserFacingError(error);
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw spoolUserFacingError(error);
    }
    let started = false;
    let commitAttempted = false;
    let discard = false;
    try {
      await client.query("BEGIN");
      started = true;
      const result = await operation(client);
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (started) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      if (commitAttempted) {
        discard = true;
        throw new SpoolDatabaseError(
          "Spool lost the database commit acknowledgement; check spool resume before recording again.",
        );
      }
      discard = isDatabaseFailure(error);
      throw spoolUserFacingError(error);
    } finally {
      client.release(discard);
    }
  }
}

export function boundResumePacket(packet: ResumePacket): ResumePacket {
  const trimmed: ResumePacket = {
    ...packet,
    goal: { ...packet.goal, outcome: truncate(packet.goal.outcome, MAX_RESUME_TEXT_CHARS) },
    nextAction: packet.nextAction ? truncate(packet.nextAction, MAX_RESUME_TEXT_CHARS) : null,
    steps: packet.steps.map((step) => ({
      ...step,
      title: truncate(step.title, MAX_RESUME_TEXT_CHARS),
      last: {
        ...step.last,
        summary: truncate(step.last.summary, MAX_RESUME_TEXT_CHARS),
        evidenceRef: step.last.evidenceRef
          ? truncate(step.last.evidenceRef, MAX_RESUME_TEXT_CHARS)
          : null,
        nextAction: step.last.nextAction
          ? truncate(step.last.nextAction, MAX_RESUME_TEXT_CHARS)
          : null,
      },
    })),
  };
  while (
    Buffer.byteLength(JSON.stringify(trimmed), "utf8") > MAX_RESUME_PACKET_BYTES &&
    trimmed.steps.length > 1
  ) {
    trimmed.steps.pop();
    trimmed.omittedSteps += 1;
  }
  return trimmed;
}

export function spoolUserFacingError(error: unknown): Error {
  if (error instanceof SpoolDatabaseError) return error;
  if (!isDatabaseFailure(error)) {
    return error instanceof Error ? error : new Error("Unknown Spool failure");
  }
  return new SpoolDatabaseError(
    "Spool database operation failed or timed out. Start the configured Docker Compose database if it is stopped, then retry. The underlying work is not affected.",
  );
}

function isDatabaseFailure(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => isDatabaseFailure(entry));
  }
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  if (candidate.name === "DatabaseError") return true;
  if (typeof candidate.code === "string") {
    if (/^[0-9A-Z]{5}$/.test(candidate.code)) return true;
    if (
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(
        candidate.code,
      )
    ) {
      return true;
    }
  }
  return (
    typeof candidate.message === "string" &&
    /query read timeout|connection terminated|server closed the connection/i.test(
      candidate.message,
    )
  );
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SpoolDatabaseError(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deriveWorkId(input: { vault: string; taskId: string }): string {
  const digest = createHash("sha256")
    .update(`${input.vault}\0${input.taskId}`)
    .digest("hex")
    .slice(0, 24);
  return `work_${digest}`;
}

function mapWork(row: WorkRow): WorkRecord {
  return {
    workId: row.work_id,
    vault: row.vault,
    taskId: row.pkm_task_id,
    canonicalPath: row.canonical_path,
    outcome: row.outcome,
  };
}

function mapEvent(row: EventRow, identity: RuntimeIdentity): StepEvent {
  return {
    kind: row.kind,
    summary: row.summary,
    evidenceRef: row.evidence_ref,
    nextAction: row.next_action,
    reviewed: row.reviewed,
    session: row.pi_session_name ?? shortId(row.pi_session_id),
    mine: row.pi_session_id === identity.piSessionId,
    recordedAt: row.recorded_at.toISOString(),
  };
}

export function shortId(value: string): string {
  return value.length <= 15 ? value : `${value.slice(0, 8)}…`;
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
