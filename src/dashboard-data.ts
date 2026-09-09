import type { Pool, PoolClient } from "pg";
import type { SpoolConfig } from "./config.ts";
import {
  closeBoundedSpoolPool,
  createBoundedSpoolPool,
  spoolUserFacingError,
  type RuntimeIdentity,
} from "./spool-service.ts";

export const MAX_DASHBOARD_GOALS = 50;
export const MAX_DASHBOARD_SCOPES_PER_GOAL = 10;
export const MAX_DASHBOARD_STEPS = 50;

export type DashboardSort = "attention" | "recent" | "oldest";

export interface DashboardCounts {
  executionCompleted: number;
  running: number;
  ready: number;
  reportedInProgress: number;
  reportedFinished: number;
  participatingSessions: number;
}

export interface DashboardWorkScope {
  workId: string;
  canonicalPath: string;
  outcome: string;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface DashboardGoal {
  key: string;
  vault: string;
  taskId: string;
  latestOutcome: string;
  latestCanonicalPath: string;
  createdAt: Date;
  lastActivityAt: Date;
  workCount: number;
  omittedScopes: number;
  scopes: DashboardWorkScope[];
  counts: DashboardCounts;
}

export interface DashboardGoalSnapshot {
  queueName: string;
  snapshotAt: Date;
  readOnly: boolean;
  totalGoals: number;
  omittedGoals: number;
  sort: DashboardSort;
  goals: DashboardGoal[];
}

export type DashboardLeaseStatus = "valid" | "expired" | "not_active";

export interface DashboardAttempt {
  attempt: number;
  piSessionId: string;
  piSessionName: string | null;
  attemptState: string;
  leaseStatus: DashboardLeaseStatus;
  leaseExpiresAt: Date;
  isCurrentRuntimeOwner: boolean;
  claimedAt: Date;
  lastActivityAt: Date;
  lastTransition: string;
  lastSummary: string | null;
  nextAction: string | null;
}

export interface DashboardCheckpoint {
  name: string;
  evidenceRef: string | null;
  recordedAt: string | null;
}

export interface DashboardCompletion {
  summary: string | null;
  resultRef: string | null;
}

export interface DashboardReport {
  disposition: "in_progress" | "finished";
  summary: string;
  evidenceRef: string;
  nextAction: string | null;
  reporterPiSessionId: string;
  reporterPiSessionName: string | null;
  reportedAt: Date;
}

export interface DashboardStep {
  work: DashboardWorkScope;
  stepId: string;
  title: string;
  contribution: string;
  criteria: string;
  createdAt: Date;
  lastActivityAt: Date;
  stepState: string;
  taskState: string | null;
  latestAttempt: DashboardAttempt | null;
  checkpoint: DashboardCheckpoint | null;
  completion: DashboardCompletion | null;
  report?: DashboardReport | null;
}

export interface DashboardGoalDetail {
  queueName: string;
  snapshotAt: Date;
  readOnly: boolean;
  goal: DashboardGoal;
  totalSteps: number;
  omittedSteps: number;
  sort: DashboardSort;
  steps: DashboardStep[];
}

export interface DashboardGoalRow {
  vault: string;
  task_id: string;
  latest_outcome: string;
  latest_canonical_path: string;
  goal_created_at: Date;
  goal_last_activity_at: Date;
  work_count: string;
  completed_count: string;
  running_count: string;
  ready_count: string;
  reported_in_progress_count: string;
  reported_finished_count: string;
  session_count: string;
  total_goals: string;
  work_id: string;
  canonical_path: string;
  outcome: string;
  work_created_at: Date;
  work_last_activity_at: Date;
}

interface StepRow {
  work_id: string;
  canonical_path: string;
  outcome: string;
  work_created_at: Date;
  work_last_activity_at: Date;
  step_id: string;
  title: string;
  contribution: string;
  completion_criteria: string;
  step_created_at: Date;
  last_activity_at: Date;
  step_state: string;
  absurd_task_id: string | null;
  total_steps: string;
  absurd_run_id: string | null;
  absurd_attempt: number | null;
  pi_session_id: string | null;
  pi_session_name: string | null;
  runtime_id: string | null;
  attempt_state: string | null;
  lease_expires_at: Date | null;
  lease_valid: boolean | null;
  claimed_at: Date | null;
  attempt_updated_at: Date | null;
  last_transition: string | null;
  last_summary: string | null;
  next_action: string | null;
  report_disposition: "in_progress" | "finished" | null;
  report_summary: string | null;
  report_evidence_ref: string | null;
  report_next_action: string | null;
  reporter_pi_session_id: string | null;
  reporter_pi_session_name: string | null;
  reported_at: Date | null;
}

interface CheckpointRow {
  task_id: string;
  run_id: string;
  checkpoint_name: string;
  state: unknown;
}

interface ResultRow {
  task_id: string;
  task_state: string;
  result: unknown;
}

export class DashboardCancelledError extends Error {
  constructor() {
    super("Spool dashboard load cancelled");
    this.name = "DashboardCancelledError";
  }
}

export class SpoolDashboardReader {
  private closed = false;
  private readonly pool: Pool;
  readonly queueName: string;
  private readonly ownsPool: boolean;

  constructor(pool: Pool, queueName: string, ownsPool = false) {
    this.pool = pool;
    this.queueName = queueName;
    this.ownsPool = ownsPool;
  }

  static connect(config: SpoolConfig): SpoolDashboardReader {
    return new SpoolDashboardReader(
      createBoundedSpoolPool(config.databaseUrl),
      config.queueName,
      true,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await closeBoundedSpoolPool(this.pool);
  }

  async loadGoals(
    sort: DashboardSort = "attention",
    signal?: AbortSignal,
  ): Promise<DashboardGoalSnapshot> {
    return await this.readOnly(async (client) => {
      const metadata = await snapshotMetadata(client, signal);
      const result = await client.query<DashboardGoalRow>(
        `WITH work_enriched AS (
           SELECT w.*,
                  greatest(
                    w.updated_at,
                    coalesce((
                      SELECT max(s.updated_at) FROM spool.steps s
                       WHERE s.work_id = w.work_id
                    ), w.updated_at),
                    coalesce((
                      SELECT max(a.updated_at) FROM spool.attempts a
                       WHERE a.work_id = w.work_id
                    ), w.updated_at),
                    coalesce((
                      SELECT max(r.reported_at) FROM spool.step_reports r
                       WHERE r.work_id = w.work_id
                    ), w.updated_at)
                  ) AS work_last_activity_at
             FROM spool.works w
            WHERE w.queue_name = $1
         ),
         work_base AS (
           SELECT we.*,
                  row_number() OVER (
                    PARTITION BY we.vault, we.pkm_task_id
                    ORDER BY we.updated_at DESC, we.work_id
                  ) AS work_rank,
                  count(*) OVER (
                    PARTITION BY we.vault, we.pkm_task_id
                  )::text AS work_count,
                  min(we.created_at) OVER (
                    PARTITION BY we.vault, we.pkm_task_id
                  ) AS goal_created_at,
                  max(we.work_last_activity_at) OVER (
                    PARTITION BY we.vault, we.pkm_task_id
                  ) AS goal_last_activity_at
             FROM work_enriched we
         ),
         latest_attempt AS (
           SELECT DISTINCT ON (a.work_id, a.step_id)
                  a.work_id, a.step_id, a.state AS attempt_state,
                  a.lease_expires_at > absurd.current_time() AS lease_valid
             FROM spool.attempts a
             JOIN work_base wb ON wb.work_id = a.work_id
            ORDER BY a.work_id, a.step_id,
                     a.claimed_at DESC, a.attempt_id DESC
         ),
         step_stats AS (
           SELECT wb.vault, wb.pkm_task_id,
                  count(s.step_id) FILTER (
                    WHERE s.state = 'execution_completed' AND reports.step_id IS NULL
                  )::text AS completed_count,
                  count(s.step_id) FILTER (
                    WHERE s.state = 'running' AND reports.step_id IS NULL
                  )::text AS running_count,
                  count(s.step_id) FILTER (
                    WHERE s.state = 'ready' AND reports.step_id IS NULL
                  )::text AS ready_count,
                  count(reports.step_id) FILTER (
                    WHERE reports.disposition = 'in_progress'
                  )::text AS reported_in_progress_count,
                  count(reports.step_id) FILTER (
                    WHERE reports.disposition = 'finished'
                  )::text AS reported_finished_count,
                  count(s.step_id) FILTER (
                    WHERE la.attempt_state = 'active' AND la.lease_valid
                  )::text AS active_valid_count,
                  count(s.step_id) FILTER (
                    WHERE la.attempt_state = 'active' AND NOT la.lease_valid
                  )::text AS expired_active_count
             FROM work_base wb
             LEFT JOIN spool.steps s ON s.work_id = wb.work_id
             LEFT JOIN latest_attempt la
               ON la.work_id = s.work_id AND la.step_id = s.step_id
             LEFT JOIN spool.step_reports reports
               ON reports.work_id = s.work_id AND reports.step_id = s.step_id
            GROUP BY wb.vault, wb.pkm_task_id
         ),
         session_stats AS (
           SELECT wb.vault, wb.pkm_task_id,
                  count(DISTINCT a.pi_session_id)::text AS session_count
             FROM work_base wb
             LEFT JOIN spool.attempts a ON a.work_id = wb.work_id
            GROUP BY wb.vault, wb.pkm_task_id
         ),
         goal_source AS (
           SELECT wb.vault, wb.pkm_task_id AS task_id,
                  wb.outcome AS latest_outcome,
                  wb.canonical_path AS latest_canonical_path,
                  wb.goal_created_at, wb.goal_last_activity_at,
                  wb.work_count,
                  ss.completed_count, ss.running_count, ss.ready_count,
                  ss.reported_in_progress_count, ss.reported_finished_count,
                  ss.active_valid_count, ss.expired_active_count,
                  sessions.session_count
             FROM work_base wb
             JOIN step_stats ss USING (vault, pkm_task_id)
             JOIN session_stats sessions USING (vault, pkm_task_id)
            WHERE wb.work_rank = 1
         ),
         ranked_goals AS (
           SELECT gs.*,
                  row_number() OVER (
                    ORDER BY ${goalSortSql(sort)}
                  ) AS goal_rank,
                  count(*) OVER ()::text AS total_goals
             FROM goal_source gs
         )
         SELECT g.vault, g.task_id, g.latest_outcome,
                g.latest_canonical_path,
                g.goal_created_at, g.goal_last_activity_at,
                g.work_count, g.completed_count, g.running_count,
                g.ready_count, g.reported_in_progress_count,
                g.reported_finished_count, g.session_count, g.total_goals,
                wb.work_id, wb.canonical_path, wb.outcome,
                wb.created_at AS work_created_at,
                wb.work_last_activity_at
           FROM ranked_goals g
           JOIN work_base wb
             ON wb.vault = g.vault AND wb.pkm_task_id = g.task_id
            AND wb.work_rank <= $3
          WHERE g.goal_rank <= $2
          ORDER BY g.goal_rank, wb.work_rank`,
        [this.queueName, MAX_DASHBOARD_GOALS, MAX_DASHBOARD_SCOPES_PER_GOAL],
      );
      throwIfAborted(signal);
      const goals = groupGoalRows(result.rows);
      const totalGoals = Number(result.rows[0]?.total_goals ?? 0);
      return {
        queueName: this.queueName,
        snapshotAt: metadata.snapshotAt,
        readOnly: metadata.readOnly,
        totalGoals,
        omittedGoals: Math.max(totalGoals - goals.length, 0),
        sort,
        goals,
      };
    }, signal);
  }

  async loadGoal(
    goal: DashboardGoal,
    viewer: RuntimeIdentity,
    sort: DashboardSort = "attention",
    signal?: AbortSignal,
  ): Promise<DashboardGoalDetail> {
    return await this.readOnly(async (client) => {
      const metadata = await snapshotMetadata(client, signal);
      const refreshedGoal = await loadGoalSummary(
        client,
        this.queueName,
        goal.vault,
        goal.taskId,
        signal,
      );
      if (!refreshedGoal) {
        throw new Error(
          "The selected Spool goal is no longer present; return to the goal list and refresh",
        );
      }
      const selected = await client.query<StepRow>(
        `WITH latest_attempt AS (
           SELECT DISTINCT ON (a.work_id, a.step_id)
                  a.work_id, a.step_id, a.absurd_run_id, a.absurd_attempt,
                  a.pi_session_id, a.pi_session_name, a.runtime_id,
                  a.state AS attempt_state, a.lease_expires_at,
                  a.lease_expires_at > absurd.current_time() AS lease_valid,
                  a.claimed_at, a.updated_at AS attempt_updated_at,
                  a.last_transition, a.last_summary, a.next_action
             FROM spool.attempts a
             JOIN spool.works aw ON aw.work_id = a.work_id
            WHERE aw.queue_name = $1 AND aw.vault = $2
              AND aw.pkm_task_id = $3
            ORDER BY a.work_id, a.step_id, a.claimed_at DESC, a.attempt_id DESC
         ),
         candidate_source AS (
           SELECT w.work_id, w.canonical_path, w.outcome,
                  w.created_at AS work_created_at,
                  greatest(
                    w.updated_at,
                    coalesce((
                      SELECT max(ws.updated_at) FROM spool.steps ws
                       WHERE ws.work_id = w.work_id
                    ), w.updated_at),
                    coalesce((
                      SELECT max(wa.updated_at) FROM spool.attempts wa
                       WHERE wa.work_id = w.work_id
                    ), w.updated_at),
                    coalesce((
                      SELECT max(wr.reported_at) FROM spool.step_reports wr
                       WHERE wr.work_id = w.work_id
                    ), w.updated_at)
                  ) AS work_last_activity_at,
                  s.step_id, s.title, s.contribution,
                  s.completion_criteria, s.created_at AS step_created_at,
                  greatest(
                    s.updated_at,
                    coalesce(a.attempt_updated_at, s.updated_at),
                    coalesce(reports.reported_at, s.updated_at)
                  ) AS last_activity_at,
                  s.state AS step_state, s.absurd_task_id,
                  a.absurd_run_id, a.absurd_attempt, a.pi_session_id,
                  a.pi_session_name, a.runtime_id, a.attempt_state,
                  a.lease_expires_at, a.lease_valid,
                  a.claimed_at, a.attempt_updated_at,
                  a.last_transition, a.last_summary, a.next_action,
                  reports.disposition AS report_disposition,
                  reports.summary AS report_summary,
                  reports.evidence_ref AS report_evidence_ref,
                  reports.next_action AS report_next_action,
                  reports.reporter_pi_session_id,
                  reports.reporter_pi_session_name,
                  reports.reported_at
             FROM spool.works w
             JOIN spool.steps s ON s.work_id = w.work_id
             LEFT JOIN latest_attempt a
               ON a.work_id = s.work_id AND a.step_id = s.step_id
             LEFT JOIN spool.step_reports reports
               ON reports.work_id = s.work_id AND reports.step_id = s.step_id
            WHERE w.queue_name = $1 AND w.vault = $2
              AND w.pkm_task_id = $3
         ),
         ranked AS (
           SELECT cs.*,
                  count(*) OVER ()::text AS total_steps,
                  row_number() OVER (
                    ORDER BY ${stepSortSql(sort)}
                  ) AS display_rank
             FROM candidate_source cs
         )
         SELECT * FROM ranked
          WHERE display_rank <= $4
          ORDER BY display_rank`,
        [this.queueName, goal.vault, goal.taskId, MAX_DASHBOARD_STEPS],
      );
      throwIfAborted(signal);

      const checkpoints = await loadLatestCheckpoints(
        client,
        this.queueName,
        selected.rows,
        signal,
      );
      const results = await loadTaskResults(
        client,
        this.queueName,
        selected.rows,
        signal,
      );
      const steps = selected.rows.map((row) =>
        mapStep(row, viewer, checkpoints, results),
      );
      const totalSteps = Number(selected.rows[0]?.total_steps ?? 0);
      return {
        queueName: this.queueName,
        snapshotAt: metadata.snapshotAt,
        readOnly: metadata.readOnly,
        goal: refreshedGoal,
        totalSteps,
        omittedSteps: Math.max(totalSteps - steps.length, 0),
        sort,
        steps,
      };
    }, signal);
  }

  private async readOnly<T>(
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw spoolUserFacingError(error);
    }
    let started = false;
    let discard = false;
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      started = true;
      throwIfAborted(signal);
      const result = await operation(client);
      throwIfAborted(signal);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (started) await client.query("ROLLBACK").catch(() => undefined);
      const safe = spoolUserFacingError(error);
      discard = safe !== error;
      throw safe;
    } finally {
      client.release(discard);
    }
  }
}

export function dashboardGoalKey(vault: string, taskId: string): string {
  return JSON.stringify([vault, taskId]);
}

export function groupGoalRows(
  rows: readonly DashboardGoalRow[],
): DashboardGoal[] {
  const grouped = new Map<string, DashboardGoal>();
  for (const row of rows) {
    const key = dashboardGoalKey(row.vault, row.task_id);
    let goal = grouped.get(key);
    if (!goal) {
      const workCount = Number(row.work_count);
      goal = {
        key,
        vault: row.vault,
        taskId: row.task_id,
        latestOutcome: row.latest_outcome,
        latestCanonicalPath: row.latest_canonical_path,
        createdAt: row.goal_created_at,
        lastActivityAt: row.goal_last_activity_at,
        workCount,
        omittedScopes: workCount,
        scopes: [],
        counts: {
          executionCompleted: Number(row.completed_count),
          running: Number(row.running_count),
          ready: Number(row.ready_count),
          reportedInProgress: Number(row.reported_in_progress_count),
          reportedFinished: Number(row.reported_finished_count),
          participatingSessions: Number(row.session_count),
        },
      };
      grouped.set(key, goal);
    }
    if (!goal.scopes.some((scope) => scope.workId === row.work_id)) {
      goal.scopes.push({
        workId: row.work_id,
        canonicalPath: row.canonical_path,
        outcome: row.outcome,
        createdAt: row.work_created_at,
        lastActivityAt: row.work_last_activity_at,
      });
      goal.omittedScopes = Math.max(goal.workCount - goal.scopes.length, 0);
    }
  }
  return [...grouped.values()];
}

export function nextDashboardSort(sort: DashboardSort): DashboardSort {
  if (sort === "attention") return "recent";
  if (sort === "recent") return "oldest";
  return "attention";
}

function goalSortSql(sort: DashboardSort): string {
  if (sort === "recent") {
    return "gs.goal_last_activity_at DESC, gs.vault, gs.task_id";
  }
  if (sort === "oldest") {
    return "gs.goal_last_activity_at ASC, gs.vault, gs.task_id";
  }
  return `(gs.active_valid_count::bigint > 0) DESC,
          (gs.expired_active_count::bigint > 0) DESC,
          (gs.reported_in_progress_count::bigint > 0) DESC,
          (gs.ready_count::bigint > 0) DESC,
          gs.goal_last_activity_at DESC, gs.vault, gs.task_id`;
}

function stepSortSql(sort: DashboardSort): string {
  if (sort === "recent") {
    return "cs.last_activity_at DESC, cs.work_id, cs.step_id";
  }
  if (sort === "oldest") {
    return "cs.last_activity_at ASC, cs.work_id, cs.step_id";
  }
  return `CASE
            WHEN cs.attempt_state = 'active' AND cs.lease_valid THEN 0
            WHEN cs.attempt_state = 'active' AND NOT cs.lease_valid THEN 1
            WHEN cs.report_disposition = 'in_progress' THEN 2
            WHEN cs.step_state = 'running' THEN 3
            WHEN cs.step_state = 'ready' AND cs.report_disposition IS NULL THEN 4
            WHEN cs.report_disposition = 'finished' THEN 5
            ELSE 6
          END,
          cs.last_activity_at DESC, cs.work_id, cs.step_id`;
}

export function formatDashboardCounts(counts: DashboardCounts): string {
  return `Tracked in Spool: ${counts.executionCompleted} complete · ${counts.running} running · ${counts.ready} ready · ${counts.reportedInProgress} reported active · ${counts.reportedFinished} reported finished · ${counts.participatingSessions} session(s)`;
}

async function loadGoalSummary(
  client: PoolClient,
  queueName: string,
  vault: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<DashboardGoal | null> {
  throwIfAborted(signal);
  const result = await client.query<DashboardGoalRow>(
    `WITH work_enriched AS (
       SELECT w.*,
              greatest(
                w.updated_at,
                coalesce((
                  SELECT max(s.updated_at) FROM spool.steps s
                   WHERE s.work_id = w.work_id
                ), w.updated_at),
                coalesce((
                  SELECT max(a.updated_at) FROM spool.attempts a
                   WHERE a.work_id = w.work_id
                ), w.updated_at),
                coalesce((
                  SELECT max(r.reported_at) FROM spool.step_reports r
                   WHERE r.work_id = w.work_id
                ), w.updated_at)
              ) AS work_last_activity_at
         FROM spool.works w
        WHERE w.queue_name = $1 AND w.vault = $2
          AND w.pkm_task_id = $3
     ),
     work_base AS (
       SELECT we.*,
              row_number() OVER (
                ORDER BY we.updated_at DESC, we.work_id
              ) AS work_rank,
              count(*) OVER ()::text AS work_count,
              min(we.created_at) OVER () AS goal_created_at,
              max(we.work_last_activity_at) OVER () AS goal_last_activity_at
         FROM work_enriched we
     ),
     step_stats AS (
       SELECT count(s.step_id) FILTER (
                WHERE s.state = 'execution_completed' AND reports.step_id IS NULL
              )::text AS completed_count,
              count(s.step_id) FILTER (
                WHERE s.state = 'running' AND reports.step_id IS NULL
              )::text AS running_count,
              count(s.step_id) FILTER (
                WHERE s.state = 'ready' AND reports.step_id IS NULL
              )::text AS ready_count,
              count(reports.step_id) FILTER (
                WHERE reports.disposition = 'in_progress'
              )::text AS reported_in_progress_count,
              count(reports.step_id) FILTER (
                WHERE reports.disposition = 'finished'
              )::text AS reported_finished_count
         FROM work_base wb
         LEFT JOIN spool.steps s ON s.work_id = wb.work_id
         LEFT JOIN spool.step_reports reports
           ON reports.work_id = s.work_id AND reports.step_id = s.step_id
     ),
     session_stats AS (
       SELECT count(DISTINCT a.pi_session_id)::text AS session_count
         FROM work_base wb
         LEFT JOIN spool.attempts a ON a.work_id = wb.work_id
     )
     SELECT wb.vault, wb.pkm_task_id AS task_id,
            latest.outcome AS latest_outcome,
            latest.canonical_path AS latest_canonical_path,
            wb.goal_created_at, wb.goal_last_activity_at,
            wb.work_count,
            stats.completed_count, stats.running_count, stats.ready_count,
            stats.reported_in_progress_count, stats.reported_finished_count,
            sessions.session_count, '1'::text AS total_goals,
            wb.work_id, wb.canonical_path, wb.outcome,
            wb.created_at AS work_created_at,
            wb.work_last_activity_at
       FROM work_base wb
       CROSS JOIN work_base latest
       CROSS JOIN step_stats stats
       CROSS JOIN session_stats sessions
      WHERE latest.work_rank = 1 AND wb.work_rank <= $4
      ORDER BY wb.work_rank`,
    [queueName, vault, taskId, MAX_DASHBOARD_SCOPES_PER_GOAL],
  );
  throwIfAborted(signal);
  return groupGoalRows(result.rows)[0] ?? null;
}

async function snapshotMetadata(
  client: PoolClient,
  signal?: AbortSignal,
): Promise<{ snapshotAt: Date; readOnly: boolean }> {
  throwIfAborted(signal);
  const result = await client.query<{ snapshot_at: Date; read_only: boolean }>(
    `SELECT absurd.current_time() AS snapshot_at,
            current_setting('transaction_read_only')::boolean AS read_only`,
  );
  throwIfAborted(signal);
  const metadata = result.rows[0]!;
  if (!metadata.read_only) {
    throw new Error("Spool dashboard refused a non-read-only transaction");
  }
  return {
    snapshotAt: metadata.snapshot_at,
    readOnly: metadata.read_only,
  };
}

async function loadLatestCheckpoints(
  client: PoolClient,
  queueName: string,
  steps: readonly StepRow[],
  signal?: AbortSignal,
): Promise<Map<string, DashboardCheckpoint>> {
  const attempts = steps.filter(
    (step): step is StepRow & { absurd_task_id: string; absurd_run_id: string } =>
      step.absurd_task_id !== null && step.absurd_run_id !== null,
  );
  if (attempts.length === 0) return new Map();
  throwIfAborted(signal);
  const values = attempts
    .map(
      (_attempt, index) =>
        `($${index * 2 + 2}::uuid, $${index * 2 + 3}::uuid)`,
    )
    .join(", ");
  const params: unknown[] = [queueName];
  for (const attempt of attempts) {
    params.push(attempt.absurd_task_id, attempt.absurd_run_id);
  }
  const result = await client.query<CheckpointRow>(
    `WITH selected(task_id, run_id) AS (VALUES ${values}),
          ranked AS (
            SELECT selected.task_id::text, selected.run_id::text,
                   checkpoint.checkpoint_name, checkpoint.state,
                   row_number() OVER (
                     PARTITION BY selected.task_id, selected.run_id
                     ORDER BY checkpoint.updated_at DESC,
                              checkpoint.checkpoint_name
                   ) AS checkpoint_rank
              FROM selected
              CROSS JOIN LATERAL absurd.get_task_checkpoint_states(
                $1, selected.task_id, selected.run_id
              ) checkpoint
          )
     SELECT task_id, run_id, checkpoint_name, state
       FROM ranked WHERE checkpoint_rank = 1`,
    params,
  );
  throwIfAborted(signal);
  return new Map(
    result.rows.map((row) => {
      const state = jsonObject(row.state);
      return [
        attemptKey(row.task_id, row.run_id),
        {
          name: row.checkpoint_name,
          evidenceRef: jsonString(state, "evidenceRef"),
          recordedAt: jsonString(state, "recordedAt"),
        },
      ];
    }),
  );
}

async function loadTaskResults(
  client: PoolClient,
  queueName: string,
  steps: readonly StepRow[],
  signal?: AbortSignal,
): Promise<Map<string, ResultRow>> {
  const taskIds = [
    ...new Set(
      steps
        .map((step) => step.absurd_task_id)
        .filter((taskId): taskId is string => taskId !== null),
    ),
  ];
  if (taskIds.length === 0) return new Map();
  throwIfAborted(signal);
  const values = taskIds
    .map((_taskId, index) => `($${index + 2}::uuid)`)
    .join(", ");
  const result = await client.query<ResultRow>(
    `WITH selected(task_id) AS (VALUES ${values})
     SELECT selected.task_id::text,
            task_result.state AS task_state,
            task_result.result
       FROM selected
       CROSS JOIN LATERAL absurd.get_task_result($1, selected.task_id) task_result`,
    [queueName, ...taskIds],
  );
  throwIfAborted(signal);
  return new Map(result.rows.map((row) => [row.task_id, row]));
}

function mapStep(
  row: StepRow,
  viewer: RuntimeIdentity,
  checkpoints: ReadonlyMap<string, DashboardCheckpoint>,
  results: ReadonlyMap<string, ResultRow>,
): DashboardStep {
  const taskResult = row.absurd_task_id
    ? results.get(row.absurd_task_id)
    : undefined;
  const result = jsonObject(taskResult?.result);
  const active = row.attempt_state === "active";
  const leaseStatus: DashboardLeaseStatus = active
    ? row.lease_valid
      ? "valid"
      : "expired"
    : "not_active";
  return {
    work: {
      workId: row.work_id,
      canonicalPath: row.canonical_path,
      outcome: row.outcome,
      createdAt: row.work_created_at,
      lastActivityAt: row.work_last_activity_at,
    },
    stepId: row.step_id,
    title: row.title,
    contribution: row.contribution,
    criteria: row.completion_criteria,
    createdAt: row.step_created_at,
    lastActivityAt: row.last_activity_at,
    stepState: row.report_disposition
      ? `reported_${row.report_disposition}_untracked`
      : row.step_state,
    taskState: taskResult?.task_state ?? null,
    latestAttempt:
      row.absurd_attempt !== null &&
      row.pi_session_id !== null &&
      row.lease_expires_at !== null &&
      row.attempt_state !== null &&
      row.last_transition !== null
        ? {
            attempt: row.absurd_attempt,
            piSessionId: row.pi_session_id,
            piSessionName: row.pi_session_name,
            attemptState: row.attempt_state,
            leaseStatus,
            leaseExpiresAt: row.lease_expires_at,
            isCurrentRuntimeOwner:
              active &&
              leaseStatus === "valid" &&
              row.pi_session_id === viewer.piSessionId &&
              row.runtime_id === viewer.runtimeId,
            claimedAt: row.claimed_at!,
            lastActivityAt: row.attempt_updated_at!,
            lastTransition: row.last_transition,
            lastSummary: row.last_summary,
            nextAction: row.next_action,
          }
        : null,
    checkpoint:
      row.absurd_task_id && row.absurd_run_id
        ? (checkpoints.get(attemptKey(row.absurd_task_id, row.absurd_run_id)) ??
          null)
        : null,
    completion:
      taskResult?.task_state === "completed"
        ? {
            summary: jsonString(result, "summary"),
            resultRef: jsonString(result, "resultRef"),
          }
        : null,
    report:
      row.report_disposition &&
      row.report_summary &&
      row.report_evidence_ref &&
      row.reporter_pi_session_id &&
      row.reported_at
        ? {
            disposition: row.report_disposition,
            summary: row.report_summary,
            evidenceRef: row.report_evidence_ref,
            nextAction: row.report_next_action,
            reporterPiSessionId: row.reporter_pi_session_id,
            reporterPiSessionName: row.reporter_pi_session_name,
            reportedAt: row.reported_at,
          }
        : null,
  };
}

function attemptKey(taskId: string, runId: string): string {
  return `${taskId}\0${runId}`;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonString(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const field = value?.[key];
  return typeof field === "string" ? field : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DashboardCancelledError();
}
