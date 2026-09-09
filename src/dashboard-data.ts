import type { Pool, PoolClient } from "pg";
import type { SpoolConfig } from "./config.ts";
import {
  closeBoundedSpoolPool,
  createBoundedSpoolPool,
  spoolUserFacingError,
  type EventKind,
  type RuntimeIdentity,
} from "./spool-service.ts";

export const MAX_DASHBOARD_GOALS = 50;
export const MAX_DASHBOARD_STEPS = 50;
export const MAX_DASHBOARD_EVENTS = 100;

export interface DashboardGoal {
  workId: string;
  vault: string;
  taskId: string;
  canonicalPath: string;
  outcome: string;
  createdAt: Date;
  lastActivityAt: Date;
  openSteps: number;
  doneSteps: number;
  sessions: number;
}

export interface DashboardSnapshot {
  snapshotAt: Date;
  totalGoals: number;
  omittedGoals: number;
  goals: DashboardGoal[];
}

export interface DashboardEvent {
  kind: EventKind;
  summary: string;
  evidenceRef: string | null;
  nextAction: string | null;
  reviewed: boolean;
  sessionId: string;
  sessionName: string | null;
  sessionFile: string | null;
  recordedAt: Date;
  mine: boolean;
}

export interface DashboardStep {
  stepId: string;
  title: string;
  state: "open" | "done";
  reviewed: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  eventCount: number;
  last: DashboardEvent;
}

export interface DashboardGoalDetail {
  snapshotAt: Date;
  goal: DashboardGoal;
  totalSteps: number;
  omittedSteps: number;
  steps: DashboardStep[];
}

export interface DashboardStepHistory {
  snapshotAt: Date;
  goal: DashboardGoal;
  step: DashboardStep;
  events: DashboardEvent[];
  omittedEvents: number;
}

export class DashboardCancelledError extends Error {
  constructor() {
    super("Spool dashboard load cancelled");
    this.name = "DashboardCancelledError";
  }
}

interface GoalRow {
  work_id: string;
  vault: string;
  pkm_task_id: string;
  canonical_path: string;
  outcome: string;
  created_at: Date;
  last_activity_at: Date;
  open_steps: string;
  done_steps: string;
  sessions: string;
  total_goals: string;
}

interface EventRow {
  kind: EventKind;
  summary: string;
  evidence_ref: string | null;
  next_action: string | null;
  reviewed: boolean;
  pi_session_id: string;
  pi_session_name: string | null;
  pi_session_file: string | null;
  recorded_at: Date;
}

interface StepRow extends EventRow {
  step_id: string;
  title: string;
  created_at: Date;
  event_count: string;
  total_steps: string;
}

/** Read-only snapshots of the work log for the `/spool` browser. */
export class SpoolDashboardReader {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private closed = false;

  constructor(pool: Pool, ownsPool = false) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  static connect(config: SpoolConfig): SpoolDashboardReader {
    return new SpoolDashboardReader(createBoundedSpoolPool(config.databaseUrl), true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await closeBoundedSpoolPool(this.pool);
  }

  async loadGoals(signal?: AbortSignal): Promise<DashboardSnapshot> {
    return await this.readOnly(signal, async (client) => {
      const rows = await client.query<GoalRow>(
        `WITH last_events AS (
           SELECT DISTINCT ON (work_id, step_id) work_id, step_id, kind, recorded_at
             FROM spool.events
            ORDER BY work_id, step_id, recorded_at DESC, seq DESC
         ),
         per_work AS (
           SELECT w.work_id,
                  count(*) FILTER (WHERE le.kind = 'note') AS open_steps,
                  count(*) FILTER (WHERE le.kind = 'done') AS done_steps,
                  greatest(w.updated_at, max(le.recorded_at)) AS last_activity_at
             FROM spool.works w
             LEFT JOIN last_events le ON le.work_id = w.work_id
            GROUP BY w.work_id, w.updated_at
         )
         SELECT w.work_id, w.vault, w.pkm_task_id, w.canonical_path, w.outcome,
                w.created_at, pw.last_activity_at,
                pw.open_steps::text, pw.done_steps::text,
                (SELECT count(DISTINCT pi_session_id) FROM spool.events e
                  WHERE e.work_id = w.work_id)::text AS sessions,
                count(*) OVER ()::text AS total_goals
           FROM spool.works w
           JOIN per_work pw ON pw.work_id = w.work_id
          ORDER BY pw.last_activity_at DESC, w.work_id
          LIMIT $1`,
        [MAX_DASHBOARD_GOALS],
      );
      const goals = rows.rows.map(mapGoal);
      const total = Number(rows.rows[0]?.total_goals ?? 0);
      return {
        snapshotAt: new Date(),
        totalGoals: total,
        omittedGoals: Math.max(0, total - goals.length),
        goals,
      };
    });
  }

  async loadGoal(
    goal: DashboardGoal,
    viewer: RuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<DashboardGoalDetail> {
    return await this.readOnly(signal, async (client) => {
      const rows = await client.query<StepRow>(
        `WITH latest AS (
           SELECT DISTINCT ON (step_id) *
             FROM spool.events
            WHERE work_id = $1
            ORDER BY step_id, recorded_at DESC, seq DESC
         )
         SELECT s.step_id, s.title, s.created_at,
                l.kind, l.summary, l.evidence_ref, l.next_action, l.reviewed,
                l.pi_session_id, l.pi_session_name, l.pi_session_file, l.recorded_at,
                (SELECT count(*) FROM spool.events e
                  WHERE e.work_id = s.work_id AND e.step_id = s.step_id)::text AS event_count,
                count(*) OVER ()::text AS total_steps
           FROM spool.steps s
           JOIN latest l ON l.step_id = s.step_id
          WHERE s.work_id = $1
          ORDER BY (l.kind = 'done'), l.recorded_at DESC, s.step_id
          LIMIT $2`,
        [goal.workId, MAX_DASHBOARD_STEPS],
      );
      const steps = rows.rows.map((row) => mapStep(row, viewer));
      const total = Number(rows.rows[0]?.total_steps ?? 0);
      return {
        snapshotAt: new Date(),
        goal,
        totalSteps: total,
        omittedSteps: Math.max(0, total - steps.length),
        steps,
      };
    });
  }

  async loadStep(
    goal: DashboardGoal,
    step: DashboardStep,
    viewer: RuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<DashboardStepHistory> {
    return await this.readOnly(signal, async (client) => {
      const rows = await client.query<EventRow & { total_events: string }>(
        `SELECT kind, summary, evidence_ref, next_action, reviewed,
                pi_session_id, pi_session_name, pi_session_file, recorded_at,
                count(*) OVER ()::text AS total_events
           FROM spool.events
          WHERE work_id = $1 AND step_id = $2
          ORDER BY recorded_at DESC, seq DESC
          LIMIT $3`,
        [goal.workId, step.stepId, MAX_DASHBOARD_EVENTS],
      );
      const events = rows.rows.map((row) => mapEvent(row, viewer));
      const total = Number(rows.rows[0]?.total_events ?? 0);
      return {
        snapshotAt: new Date(),
        goal,
        step,
        events,
        omittedEvents: Math.max(0, total - events.length),
      };
    });
  }

  private async readOnly<T>(
    signal: AbortSignal | undefined,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new DashboardCancelledError();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw spoolUserFacingError(error);
    }
    let discard = false;
    try {
      if (signal?.aborted) throw new DashboardCancelledError();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        discard = true;
      });
      if (error instanceof DashboardCancelledError) throw error;
      if (signal?.aborted) throw new DashboardCancelledError();
      throw spoolUserFacingError(error);
    } finally {
      client.release(discard);
    }
  }
}

function mapGoal(row: GoalRow): DashboardGoal {
  return {
    workId: row.work_id,
    vault: row.vault,
    taskId: row.pkm_task_id,
    canonicalPath: row.canonical_path,
    outcome: row.outcome,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    openSteps: Number(row.open_steps),
    doneSteps: Number(row.done_steps),
    sessions: Number(row.sessions),
  };
}

function mapEvent(row: EventRow, viewer: RuntimeIdentity): DashboardEvent {
  return {
    kind: row.kind,
    summary: row.summary,
    evidenceRef: row.evidence_ref,
    nextAction: row.next_action,
    reviewed: row.reviewed,
    sessionId: row.pi_session_id,
    sessionName: row.pi_session_name,
    sessionFile: row.pi_session_file,
    recordedAt: row.recorded_at,
    mine: row.pi_session_id === viewer.piSessionId,
  };
}

function mapStep(row: StepRow, viewer: RuntimeIdentity): DashboardStep {
  const last = mapEvent(row, viewer);
  return {
    stepId: row.step_id,
    title: row.title,
    state: row.kind === "done" ? "done" : "open",
    reviewed: row.kind === "done" && row.reviewed,
    createdAt: row.created_at,
    lastActivityAt: row.recorded_at,
    eventCount: Number(row.event_count),
    last,
  };
}

export function formatGoalCounts(goal: DashboardGoal): string {
  return `${goal.openSteps} open · ${goal.doneSteps} done · ${goal.sessions} session${goal.sessions === 1 ? "" : "s"}`;
}
