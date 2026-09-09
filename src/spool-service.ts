import { createHash, randomUUID } from "node:crypto";
import { Absurd, type JsonObject, type JsonValue } from "absurd-sdk";
import { Pool, type PoolClient } from "pg";
import type { SessionBinding } from "./binding.ts";
import type { SpoolConfig } from "./config.ts";

const TASK_NAME = "spool-step";
const MAX_SELECTED_STEPS = 20;
const MAX_SELECTED_CHECKPOINTS = 20;
export const MAX_RESUME_PACKET_BYTES = 12_000;
export const SPOOL_CONNECTION_TIMEOUT_MS = 3_000;
export const SPOOL_STATEMENT_TIMEOUT_MS = 10_000;
export const SPOOL_QUERY_TIMEOUT_MS = 12_000;
export const SPOOL_CLOSE_TIMEOUT_MS = 15_000;

export interface RuntimeIdentity {
  piSessionId: string;
  piSessionName?: string;
  piSessionFile?: string;
  runtimeId: string;
}

export interface WorkRecord {
  workId: string;
  queueName: string;
  vault: string;
  taskId: string;
  canonicalPath: string;
  outcome: string;
}

export interface StepDefinition {
  stepId: string;
  title: string;
  contribution: string;
  criteria: string;
}

export interface ClaimedAttempt {
  attemptId: string;
  workId: string;
  stepId: string;
  taskId: string;
  runId: string;
  attempt: number;
  leaseExpiresAt: Date;
}

export interface StepReport {
  stepId: string;
  disposition: "in_progress" | "finished";
  summary: string;
  evidenceRef: string;
  nextAction: string | null;
  reporterPiSessionId: string;
  reporterPiSessionName: string | null;
  reporterRuntimeId: string;
  reportedAt: Date;
  execution: "untracked";
  acceptance: "not_recorded";
}

export interface ClaimUnavailable {
  claimed: false;
  tracking: "unavailable";
  reason: "queue_head_mismatch";
  rollback: "confirmed";
  intended: {
    workId: string;
    stepId: string;
    taskId: string;
  };
  head: {
    workId: string;
    stepId: string;
    taskId: string;
  };
  nextAction: string;
}

export type ClaimNextResult = ClaimedAttempt | ClaimUnavailable | null;

export function isClaimUnavailable(
  result: Exclude<ClaimNextResult, null>,
): result is ClaimUnavailable {
  return "claimed" in result && result.claimed === false;
}

export interface ResumePacket {
  goal: {
    workId: string;
    vault: string;
    taskId: string;
    canonicalPath: string;
    outcome: string;
  };
  steps: Array<{
    stepId: string;
    title: string;
    contribution: string;
    criteria: string;
    state: string;
    trackedState?: string;
    report?: StepReport | null;
    latestAttempt: null | {
      attemptId: string;
      attempt: number;
      piSessionId: string;
      piSessionName: string | null;
      state: string;
      leaseExpiresAt: Date;
      leaseValid: boolean;
      attributedToCurrentRuntime: boolean;
      ownedByCurrentRuntime: boolean;
      lastTransition: string;
      lastSummary: string | null;
      nextAction: string | null;
    };
    checkpoints: Array<{
      name: string;
      evidenceRef: string | null;
      recordedAt: string | null;
    }>;
  }>;
  nextAction: string;
  acceptance: "not_recorded";
  omissions: {
    steps: number;
    checkpoints: number;
    textFields: number;
    notice: string | null;
  };
}

export class ClaimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimConflictError";
  }
}

class QueueHeadMismatchRollback extends Error {
  readonly result: ClaimUnavailable;

  constructor(result: ClaimUnavailable) {
    super("Roll back the unrelated queue-head claim");
    this.name = "QueueHeadMismatchRollback";
    this.result = result;
  }
}

export class LostOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LostOwnershipError";
  }
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
  // pg emits idle-client failures as EventEmitter errors. Keep Docker loss
  // from crashing Pi; the next explicit operation reports the sanitized error.
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

export class SpoolService {
  private readonly pool: Pool;
  private readonly sdk: Absurd;
  private readonly ownsPool: boolean;
  readonly queueName: string;
  private closed = false;

  constructor(pool: Pool, queueName: string, ownsPool = false) {
    this.pool = pool;
    this.queueName = queueName;
    this.ownsPool = ownsPool;
    this.sdk = new Absurd({
      db: pool,
      queueName,
      log: quietLog,
    });
  }

  static connect(config: SpoolConfig): SpoolService {
    return new SpoolService(
      createBoundedSpoolPool(config.databaseUrl),
      config.queueName,
      true,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.ownsPool) return;
    await closeBoundedSpoolPool(this.pool);
  }

  async attach(
    input: {
      vault: string;
      taskId: string;
      canonicalPath: string;
      outcome: string;
    },
    identity: RuntimeIdentity,
  ): Promise<WorkRecord> {
    const workId = deriveWorkId(this.queueName, input);
    return await this.transaction(async (client) => {
      await this.reconcileEndedExpiredAttempts(
        client,
        this.sdk.bindToConnection(client),
        identity.piSessionId,
      );
      const active = await client.query<{ work_id: string }>(
        `SELECT work_id FROM spool.attempts
          WHERE pi_session_id = $1 AND state = 'active'
          FOR UPDATE`,
        [identity.piSessionId],
      );
      if (active.rows.some((row) => row.work_id !== workId)) {
        throw new Error(
          "current Pi session owns a different active attempt; complete or lose ownership before attaching another work item",
        );
      }
      const result = await client.query<{
        work_id: string;
        queue_name: string;
        vault: string;
        pkm_task_id: string;
        canonical_path: string;
        outcome: string;
      }>(
        `INSERT INTO spool.works
           (work_id, queue_name, vault, pkm_task_id, canonical_path, outcome)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (work_id) DO UPDATE
           SET outcome = EXCLUDED.outcome,
               updated_at = absurd.current_time()
         RETURNING work_id, queue_name, vault, pkm_task_id, canonical_path, outcome`,
        [
          workId,
          this.queueName,
          input.vault,
          input.taskId,
          input.canonicalPath,
          input.outcome,
        ],
      );
      return mapWork(result.rows[0]!);
    });
  }

  async reconcileBinding(binding: SessionBinding): Promise<WorkRecord> {
    const result = await this.pool.query<{
      work_id: string;
      queue_name: string;
      vault: string;
      pkm_task_id: string;
      canonical_path: string;
      outcome: string;
    }>(
      `SELECT work_id, queue_name, vault, pkm_task_id, canonical_path, outcome
         FROM spool.works
        WHERE work_id = $1 AND queue_name = $2`,
      [binding.workId, this.queueName],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.vault !== binding.vault ||
      row.pkm_task_id !== binding.taskId ||
      row.canonical_path !== binding.canonicalPath
    ) {
      throw new Error("session binding does not match durable Spool work; attach again");
    }
    return mapWork(row);
  }

  async materialize(
    binding: SessionBinding,
    definition: StepDefinition,
  ): Promise<{ stepId: string; taskId: string; created: boolean }> {
    return await this.transaction(async (client) => {
      await this.requireWork(client, binding);
      await client.query(
        `INSERT INTO spool.steps
           (work_id, step_id, title, contribution, completion_criteria)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (work_id, step_id) DO NOTHING`,
        [
          binding.workId,
          definition.stepId,
          definition.title,
          definition.contribution,
          definition.criteria,
        ],
      );
      const step = await this.lockStep(client, binding.workId, definition.stepId);
      if (
        step.title !== definition.title ||
        step.contribution !== definition.contribution ||
        step.completion_criteria !== definition.criteria
      ) {
        throw new Error(
          `step ${definition.stepId} already exists with a different definition`,
        );
      }

      const txSdk = this.sdk.bindToConnection(client);
      const spawned = await txSdk.spawn(
        TASK_NAME,
        {
          kind: TASK_NAME,
          workId: binding.workId,
          stepId: definition.stepId,
        },
        {
          queue: this.queueName,
          idempotencyKey: `spool:${binding.workId}:${definition.stepId}`,
          maxAttempts: 10,
          retryStrategy: { kind: "none" },
          headers: {
            workId: binding.workId,
            stepId: definition.stepId,
          },
        },
      );
      if (step.absurd_task_id && step.absurd_task_id !== spawned.taskID) {
        throw new Error(`step ${definition.stepId} maps to a different Absurd task`);
      }
      await client.query(
        `UPDATE spool.steps
            SET absurd_task_id = $3, updated_at = absurd.current_time()
          WHERE work_id = $1 AND step_id = $2`,
        [binding.workId, definition.stepId, spawned.taskID],
      );
      return {
        stepId: definition.stepId,
        taskId: spawned.taskID,
        created: spawned.created,
      };
    });
  }

  async claimNext(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    options: { expectedStepId?: string; leaseSeconds: number },
  ): Promise<ClaimNextResult> {
    const operation = this.transaction(async (client) => {
      await this.requireWork(client, binding);
      const current = await client.query<{
        attempt_id: string;
        absurd_task_id: string;
        runtime_id: string;
        lease_valid: boolean;
      }>(
        `SELECT attempt_id, absurd_task_id, runtime_id,
                lease_expires_at > absurd.current_time() AS lease_valid
           FROM spool.attempts
          WHERE pi_session_id = $1 AND state = 'active'
          FOR UPDATE`,
        [identity.piSessionId],
      );
      const valid = current.rows.find((attempt) => attempt.lease_valid);
      if (valid?.runtime_id === identity.runtimeId) {
        throw new Error(
          "this Pi session/runtime already holds a valid active Spool attempt",
        );
      }
      if (valid) {
        throw new LostOwnershipError(
          "this Pi session has a valid active attempt owned by another extension runtime; inspect and wait for ownership to end",
        );
      }

      const claimStartedAt = await this.databaseNow(client);
      const txSdk = this.sdk.bindToConnection(client);
      const claimed = (
        await txSdk.claimTasks({
          workerId: workerId(identity),
          claimTimeout: options.leaseSeconds,
          batchSize: 1,
        })
      )[0];
      if (!claimed) {
        // A real-clock claim poll can commit only the expired-run sweep and
        // enqueue its retry. Reconcile expired local attempts whose Absurd task
        // snapshot confirms that their running run has ended.
        await this.reconcileEndedExpiredAttempts(
          client,
          txSdk,
          identity.piSessionId,
        );
        return null;
      }

      const params = claimed.params;
      const workId = jsonString(params, "workId");
      const stepId = jsonString(params, "stepId");
      if (
        claimed.task_name !== TASK_NAME ||
        jsonString(params, "kind") !== TASK_NAME ||
        workId === null ||
        stepId === null
      ) {
        throw new ClaimConflictError(
          `queue head ${claimed.task_id}/${stepId ?? "unknown"} is not a valid admitted Spool task; claim rolled back`,
        );
      }
      if (
        workId !== binding.workId ||
        (options.expectedStepId !== undefined && stepId !== options.expectedStepId)
      ) {
        const expectedStepId = options.expectedStepId;
        if (!expectedStepId) {
          throw new ClaimConflictError(
            `queue head ${claimed.task_id}/${stepId} does not match attached work and no explicit intended step was supplied; claim rolled back`,
          );
        }
        const head = await this.lockStep(
          client,
          workId,
          stepId,
          new ClaimConflictError(
            `queue head ${claimed.task_id} is not admitted as ${workId}/${stepId}; claim rolled back`,
          ),
        );
        if (
          head.queue_name !== this.queueName ||
          head.absurd_task_id !== claimed.task_id
        ) {
          throw new ClaimConflictError(
            `queue head ${claimed.task_id} is not the admitted task for ${workId}/${stepId}; claim rolled back`,
          );
        }
        const intended = await this.requireSafeMismatchFallback(
          client,
          txSdk,
          binding,
          expectedStepId,
          current.rows.some((attempt) => !attempt.lease_valid),
        );
        throw new QueueHeadMismatchRollback({
          claimed: false,
          tracking: "unavailable",
          reason: "queue_head_mismatch",
          rollback: "confirmed",
          intended: {
            workId: binding.workId,
            stepId: expectedStepId,
            taskId: intended.absurdTaskId,
          },
          head: {
            workId,
            stepId,
            taskId: claimed.task_id,
          },
          nextAction:
            "Optional Spool tracking is unavailable because another admitted queue item is ahead. Continue otherwise authorized work untracked through normal coordination, or pause and ask if strict tracking is required. Do not retry, sweep, reorder, cancel, or claim the unrelated head.",
        });
      }

      const step = await this.lockStep(client, workId, stepId);
      if (step.absurd_task_id !== claimed.task_id) {
        throw new ClaimConflictError(
          `claimed task ${claimed.task_id} is not the admitted task for ${workId}/${stepId}`,
        );
      }

      const otherSessionWork = await client.query<{ work_id: string; step_id: string }>(
        `SELECT work_id, step_id
           FROM spool.attempts
          WHERE pi_session_id = $1 AND state = 'active'
          FOR UPDATE`,
        [identity.piSessionId],
      );
      if (
        otherSessionWork.rows.some(
          (row) => row.work_id !== workId || row.step_id !== stepId,
        )
      ) {
        throw new ClaimConflictError(
          "this Pi session still has a different active Spool binding; claim rolled back",
        );
      }

      await client.query(
        `UPDATE spool.attempts
            SET state = 'lost',
                last_transition = 'replaced',
                last_summary = 'Absurd issued a replacement run after prior ownership ended',
                updated_at = absurd.current_time()
          WHERE work_id = $1 AND step_id = $2 AND state = 'active'
            AND absurd_run_id <> $3`,
        [workId, stepId, claimed.run_id],
      );

      // Store a conservative local deadline from before the SDK claim. The
      // upstream claim's own clock runs no earlier than this value.
      const leaseExpiresAt = new Date(
        claimStartedAt.getTime() + options.leaseSeconds * 1_000,
      );
      const attemptId = randomUUID();
      await client.query(
        `INSERT INTO spool.attempts
           (attempt_id, work_id, step_id, absurd_task_id, absurd_run_id,
            absurd_attempt, pi_session_id, pi_session_name, pi_session_file,
            runtime_id, lease_expires_at, last_transition, next_action)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'claimed', 'Checkpoint meaningful progress or complete execution')`,
        [
          attemptId,
          workId,
          stepId,
          claimed.task_id,
          claimed.run_id,
          claimed.attempt,
          identity.piSessionId,
          identity.piSessionName ?? null,
          identity.piSessionFile ?? null,
          identity.runtimeId,
          leaseExpiresAt,
        ],
      );
      await client.query(
        `UPDATE spool.steps
            SET state = 'running', updated_at = absurd.current_time()
          WHERE work_id = $1 AND step_id = $2`,
        [workId, stepId],
      );
      return {
        attemptId,
        workId,
        stepId,
        taskId: claimed.task_id,
        runId: claimed.run_id,
        attempt: claimed.attempt,
        leaseExpiresAt,
      };
    });
    try {
      return await operation;
    } catch (error) {
      if (error instanceof QueueHeadMismatchRollback) return error.result;
      throw error;
    }
  }

  async report(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: {
      stepId: string;
      disposition: "in_progress" | "finished";
      summary: string;
      evidenceRef: string;
      nextAction?: string;
    },
  ): Promise<StepReport> {
    return await this.transaction(async (client) => {
      await this.requireWork(client, binding);
      const step = await this.lockStep(client, binding.workId, input.stepId);
      const active = await client.query<{ lease_valid: boolean }>(
        `SELECT lease_expires_at > absurd.current_time() AS lease_valid
           FROM spool.attempts
          WHERE work_id = $1 AND step_id = $2 AND state = 'active'
          FOR UPDATE`,
        [binding.workId, input.stepId],
      );
      if (active.rows.some((attempt) => attempt.lease_valid)) {
        throw new LostOwnershipError(
          `step ${input.stepId} has a valid leased owner; use owned checkpoint/complete instead of report`,
        );
      }
      if (active.rows.length > 0) {
        throw new LostOwnershipError(
          `step ${input.stepId} has an unresolved expired attempt; inspect ownership before reporting`,
        );
      }

      const existing = await client.query(
        `SELECT 1 FROM spool.step_reports
          WHERE work_id = $1 AND step_id = $2
          FOR UPDATE`,
        [binding.workId, input.stepId],
      );
      if (!existing.rowCount) {
        if (step.state !== "ready" || !step.absurd_task_id) {
          throw new ClaimConflictError(
            `step ${input.stepId} is not an unclaimed admitted ready step; report refused`,
          );
        }
        const sdk = this.sdk.bindToConnection(client);
        const before = await sdk.fetchTaskResult(step.absurd_task_id, {
          queue: this.queueName,
        });
        if (!before || before.state !== "pending") {
          throw new ClaimConflictError(
            `step ${input.stepId} is not durably pending; report withdrawal is unsafe`,
          );
        }
        await sdk.cancelTask(step.absurd_task_id, this.queueName);
        const after = await sdk.fetchTaskResult(step.absurd_task_id, {
          queue: this.queueName,
        });
        if (!after || after.state !== "cancelled") {
          throw new ClaimConflictError(
            `step ${input.stepId} queue withdrawal could not be confirmed`,
          );
        }
      }

      const result = await client.query<{
        disposition: "in_progress" | "finished";
        summary: string;
        evidence_ref: string;
        next_action: string | null;
        reporter_pi_session_id: string;
        reporter_pi_session_name: string | null;
        reporter_runtime_id: string;
        reported_at: Date;
      }>(
        `INSERT INTO spool.step_reports
           (work_id, step_id, disposition, summary, evidence_ref, next_action,
            reporter_pi_session_id, reporter_pi_session_name,
            reporter_pi_session_file, reporter_runtime_id, reported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 absurd.current_time())
         ON CONFLICT (work_id, step_id) DO UPDATE
           SET disposition = EXCLUDED.disposition,
               summary = EXCLUDED.summary,
               evidence_ref = EXCLUDED.evidence_ref,
               next_action = EXCLUDED.next_action,
               reporter_pi_session_id = EXCLUDED.reporter_pi_session_id,
               reporter_pi_session_name = EXCLUDED.reporter_pi_session_name,
               reporter_pi_session_file = EXCLUDED.reporter_pi_session_file,
               reporter_runtime_id = EXCLUDED.reporter_runtime_id,
               reported_at = absurd.current_time()
         RETURNING disposition, summary, evidence_ref, next_action,
                   reporter_pi_session_id, reporter_pi_session_name,
                   reporter_runtime_id, reported_at`,
        [
          binding.workId,
          input.stepId,
          input.disposition,
          input.summary,
          input.evidenceRef,
          input.nextAction ?? null,
          identity.piSessionId,
          identity.piSessionName ?? null,
          identity.piSessionFile ?? null,
          identity.runtimeId,
        ],
      );
      const row = result.rows[0]!;
      return {
        stepId: input.stepId,
        disposition: row.disposition,
        summary: row.summary,
        evidenceRef: row.evidence_ref,
        nextAction: row.next_action,
        reporterPiSessionId: row.reporter_pi_session_id,
        reporterPiSessionName: row.reporter_pi_session_name,
        reporterRuntimeId: row.reporter_runtime_id,
        reportedAt: row.reported_at,
        execution: "untracked",
        acceptance: "not_recorded",
      };
    }, "BEGIN ISOLATION LEVEL SERIALIZABLE");
  }

  async checkpoint(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: { checkpointName: string; evidenceRef: string; nextAction?: string },
  ): Promise<void> {
    await this.transaction(async (client) => {
      const attempt = await this.requireOwnedAttempt(client, binding, identity);
      const state: JsonObject = {
        evidenceRef: input.evidenceRef,
        recordedAt: (await this.databaseNow(client)).toISOString(),
      };
      await client.query(
        "SELECT absurd.set_task_checkpoint_state($1, $2, $3, $4, $5)",
        [
          this.queueName,
          attempt.absurd_task_id,
          input.checkpointName,
          JSON.stringify(state),
          attempt.absurd_run_id,
        ],
      );
      await client.query(
        `UPDATE spool.attempts
            SET last_transition = 'checkpointed',
                last_summary = $2,
                last_checkpoint_name = $3,
                last_evidence_ref = $4,
                next_action = $5,
                updated_at = absurd.current_time()
          WHERE attempt_id = $1`,
        [
          attempt.attempt_id,
          `Recorded checkpoint ${input.checkpointName}`,
          input.checkpointName,
          input.evidenceRef,
          input.nextAction ?? null,
        ],
      );
    });
  }

  async heartbeat(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    leaseSeconds: number,
  ): Promise<Date> {
    return await this.transaction(async (client) => {
      const attempt = await this.requireOwnedAttempt(client, binding, identity);
      const heartbeatStartedAt = await this.databaseNow(client);
      await client.query("SELECT absurd.extend_claim($1, $2, $3)", [
        this.queueName,
        attempt.absurd_run_id,
        leaseSeconds,
      ]);
      const leaseExpiresAt = new Date(
        heartbeatStartedAt.getTime() + leaseSeconds * 1_000,
      );
      await client.query(
        `UPDATE spool.attempts
            SET lease_expires_at = $2,
                last_transition = 'heartbeat',
                last_summary = 'Lease renewed by explicit agent action',
                updated_at = absurd.current_time()
          WHERE attempt_id = $1`,
        [attempt.attempt_id, leaseExpiresAt],
      );
      return leaseExpiresAt;
    });
  }

  async completeExecution(
    binding: SessionBinding,
    identity: RuntimeIdentity,
    input: { resultRef: string; summary: string },
  ): Promise<void> {
    await this.transaction(async (client) => {
      const attempt = await this.requireOwnedAttempt(client, binding, identity);
      await client.query("SELECT absurd.complete_run($1, $2, $3)", [
        this.queueName,
        attempt.absurd_run_id,
        JSON.stringify({ resultRef: input.resultRef, summary: input.summary }),
      ]);
      await client.query(
        `UPDATE spool.attempts
            SET state = 'execution_completed',
                last_transition = 'execution_completed',
                last_summary = $2,
                next_action = 'Await separate review/acceptance if required',
                updated_at = absurd.current_time()
          WHERE attempt_id = $1`,
        [attempt.attempt_id, input.summary],
      );
      await client.query(
        `UPDATE spool.steps
            SET state = 'execution_completed', updated_at = absurd.current_time()
          WHERE work_id = $1 AND step_id = $2`,
        [attempt.work_id, attempt.step_id],
      );
    });
  }

  async resume(
    binding: SessionBinding,
    identity: RuntimeIdentity,
  ): Promise<ResumePacket> {
    const work = await this.reconcileBinding(binding);
    const totalSteps = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM spool.steps WHERE work_id = $1",
      [binding.workId],
    );
    const steps = await this.pool.query<{
      step_id: string;
      title: string;
      contribution: string;
      completion_criteria: string;
      state: string;
      absurd_task_id: string | null;
      report_disposition: "in_progress" | "finished" | null;
      report_summary: string | null;
      report_evidence_ref: string | null;
      report_next_action: string | null;
      reporter_pi_session_id: string | null;
      reporter_pi_session_name: string | null;
      reporter_runtime_id: string | null;
      reported_at: Date | null;
    }>(
      `SELECT s.step_id, s.title, s.contribution, s.completion_criteria,
              s.state, s.absurd_task_id,
              r.disposition AS report_disposition,
              r.summary AS report_summary,
              r.evidence_ref AS report_evidence_ref,
              r.next_action AS report_next_action,
              r.reporter_pi_session_id, r.reporter_pi_session_name,
              r.reporter_runtime_id, r.reported_at
         FROM spool.steps s
         LEFT JOIN spool.step_reports r
           ON r.work_id = s.work_id AND r.step_id = s.step_id
        WHERE s.work_id = $1
        ORDER BY
          CASE
            WHEN EXISTS (
              SELECT 1 FROM spool.attempts a
               WHERE a.work_id = s.work_id AND a.step_id = s.step_id
                 AND a.state = 'active' AND a.pi_session_id = $2
                 AND a.runtime_id = $3
            ) THEN 0
            WHEN s.step_id = $4 THEN 1
            WHEN EXISTS (
              SELECT 1 FROM spool.attempts a
               WHERE a.work_id = s.work_id AND a.step_id = s.step_id
                 AND a.state = 'active'
            ) THEN 2
            WHEN s.state = 'running' THEN 3
            ELSE 4
          END,
          s.created_at,
          s.step_id
        LIMIT $5`,
      [
        binding.workId,
        identity.piSessionId,
        identity.runtimeId,
        binding.stepId ?? "",
        MAX_SELECTED_STEPS,
      ],
    );

    let omittedCheckpoints = 0;
    const projected: ResumePacket["steps"] = [];
    for (const step of steps.rows) {
      const attempts = await this.pool.query<{
        attempt_id: string;
        absurd_run_id: string;
        absurd_attempt: number;
        pi_session_id: string;
        pi_session_name: string | null;
        runtime_id: string;
        state: string;
        lease_expires_at: Date;
        lease_valid: boolean;
        last_transition: string;
        last_summary: string | null;
        next_action: string | null;
      }>(
        `SELECT attempt_id, absurd_run_id, absurd_attempt, pi_session_id,
                pi_session_name, runtime_id, state, lease_expires_at,
                lease_expires_at > absurd.current_time() AS lease_valid,
                last_transition, last_summary, next_action
           FROM spool.attempts
          WHERE work_id = $1 AND step_id = $2
          ORDER BY claimed_at DESC
          LIMIT 1`,
        [binding.workId, step.step_id],
      );
      const latest = attempts.rows[0];
      let checkpoints: ResumePacket["steps"][number]["checkpoints"] = [];
      if (latest && step.absurd_task_id) {
        const rows = await this.pool.query<{
          checkpoint_name: string;
          state: JsonValue;
          total_count: string;
        }>(
          `SELECT checkpoint_name, state, count(*) OVER ()::text AS total_count
             FROM absurd.get_task_checkpoint_states($1, $2, $3)
            LIMIT $4`,
          [
            this.queueName,
            step.absurd_task_id,
            latest.absurd_run_id,
            MAX_SELECTED_CHECKPOINTS,
          ],
        );
        omittedCheckpoints += Math.max(
          Number(rows.rows[0]?.total_count ?? 0) - rows.rows.length,
          0,
        );
        checkpoints = rows.rows.map((row) => {
          const state = jsonObject(row.state);
          return {
            name: row.checkpoint_name,
            evidenceRef: jsonString(state, "evidenceRef"),
            recordedAt: jsonString(state, "recordedAt"),
          };
        });
      }
      const attributedToCurrentRuntime = Boolean(
        latest &&
          latest.pi_session_id === identity.piSessionId &&
          latest.runtime_id === identity.runtimeId &&
          latest.state === "active",
      );
      projected.push({
        stepId: step.step_id,
        title: step.title,
        contribution: step.contribution,
        criteria: step.completion_criteria,
        state: step.report_disposition
          ? `reported_${step.report_disposition}_untracked`
          : step.state,
        trackedState: step.state,
        report:
          step.report_disposition &&
          step.report_summary &&
          step.report_evidence_ref &&
          step.reporter_pi_session_id &&
          step.reporter_runtime_id &&
          step.reported_at
            ? {
                stepId: step.step_id,
                disposition: step.report_disposition,
                summary: step.report_summary,
                evidenceRef: step.report_evidence_ref,
                nextAction: step.report_next_action,
                reporterPiSessionId: step.reporter_pi_session_id,
                reporterPiSessionName: step.reporter_pi_session_name,
                reporterRuntimeId: step.reporter_runtime_id,
                reportedAt: step.reported_at,
                execution: "untracked",
                acceptance: "not_recorded",
              }
            : null,
        latestAttempt: latest
          ? {
              attemptId: latest.attempt_id,
              attempt: latest.absurd_attempt,
              piSessionId: latest.pi_session_id,
              piSessionName: latest.pi_session_name,
              state: latest.state,
              leaseExpiresAt: latest.lease_expires_at,
              leaseValid: latest.lease_valid,
              attributedToCurrentRuntime,
              ownedByCurrentRuntime:
                attributedToCurrentRuntime && latest.lease_valid,
              lastTransition: latest.last_transition,
              lastSummary: latest.last_summary,
              nextAction: latest.next_action,
            }
          : null,
        checkpoints,
      });
    }

    const omittedSteps = Math.max(
      Number(totalSteps.rows[0]?.count ?? 0) - projected.length,
      0,
    );
    return boundResumePacket({
      goal: {
        workId: work.workId,
        vault: work.vault,
        taskId: work.taskId,
        canonicalPath: work.canonicalPath,
        outcome: work.outcome,
      },
      steps: projected,
      nextAction: deriveNextAction(projected),
      acceptance: "not_recorded",
      omissions: {
        steps: omittedSteps,
        checkpoints: omittedCheckpoints,
        textFields: 0,
        notice:
          omittedSteps > 0 || omittedCheckpoints > 0
            ? omissionNotice(omittedSteps, omittedCheckpoints, 0)
            : null,
      },
    });
  }

  private async requireWork(
    client: PoolClient,
    binding: SessionBinding,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM spool.works
        WHERE work_id = $1 AND queue_name = $2 AND vault = $3
          AND pkm_task_id = $4 AND canonical_path = $5`,
      [
        binding.workId,
        this.queueName,
        binding.vault,
        binding.taskId,
        binding.canonicalPath,
      ],
    );
    if (!result.rowCount) {
      throw new Error("session binding does not match durable Spool work; attach again");
    }
  }

  private async lockStep(
    client: PoolClient,
    workId: string,
    stepId: string,
    missingError: Error = new Error(`step ${stepId} is not materialized`),
  ) {
    const result = await client.query<{
      title: string;
      contribution: string;
      completion_criteria: string;
      absurd_task_id: string | null;
      state: string;
      queue_name: string;
    }>(
      `SELECT s.title, s.contribution, s.completion_criteria,
              s.absurd_task_id, s.state, w.queue_name
         FROM spool.steps s
         JOIN spool.works w ON w.work_id = s.work_id
        WHERE s.work_id = $1 AND s.step_id = $2
        FOR UPDATE OF s`,
      [workId, stepId],
    );
    if (!result.rows[0]) throw missingError;
    return result.rows[0];
  }

  private async requireSafeMismatchFallback(
    client: PoolClient,
    sdk: Absurd,
    binding: SessionBinding,
    expectedStepId: string,
    sessionHasExpiredAttempt: boolean,
  ): Promise<{ absurdTaskId: string }> {
    if (sessionHasExpiredAttempt) {
      throw new LostOwnershipError(
        "this Pi session has an expired active attempt; inspect lost ownership before treating queue mismatch as optional",
      );
    }
    const intended = await this.lockStep(
      client,
      binding.workId,
      expectedStepId,
    );
    if (
      intended.queue_name !== this.queueName ||
      !intended.absurd_task_id ||
      intended.state === "execution_completed"
    ) {
      throw new ClaimConflictError(
        `intended step ${expectedStepId} is not a ready admitted task; queue-head claim rolled back`,
      );
    }
    const active = await client.query<{ lease_valid: boolean }>(
      `SELECT lease_expires_at > absurd.current_time() AS lease_valid
         FROM spool.attempts
        WHERE work_id = $1 AND step_id = $2 AND state = 'active'
        FOR UPDATE`,
      [binding.workId, expectedStepId],
    );
    if (active.rows.some((attempt) => attempt.lease_valid)) {
      throw new LostOwnershipError(
        `intended step ${expectedStepId} has a valid active owner; queue mismatch cannot be treated as optional tracking`,
      );
    }
    if (active.rows.length > 0) {
      throw new LostOwnershipError(
        `intended step ${expectedStepId} has an expired active attempt; inspect lost ownership before retrying`,
      );
    }
    if (intended.state !== "ready") {
      throw new ClaimConflictError(
        `intended step ${expectedStepId} is ${intended.state} without a verifiable active owner; queue-head claim rolled back`,
      );
    }
    const task = await sdk.fetchTaskResult(intended.absurd_task_id, {
      queue: this.queueName,
    });
    if (!task || task.state !== "pending") {
      throw new ClaimConflictError(
        `intended step ${expectedStepId} is not durably pending in the configured queue; ownership status is ambiguous and the queue-head claim was rolled back`,
      );
    }
    return { absurdTaskId: intended.absurd_task_id };
  }

  private async requireOwnedAttempt(
    client: PoolClient,
    binding: SessionBinding,
    identity: RuntimeIdentity,
  ) {
    const result = await client.query<{
      attempt_id: string;
      work_id: string;
      step_id: string;
      absurd_task_id: string;
      absurd_run_id: string;
      lease_expires_at: Date;
      lease_valid: boolean;
    }>(
      `SELECT attempt_id, work_id, step_id, absurd_task_id, absurd_run_id,
              lease_expires_at,
              lease_expires_at > absurd.current_time() AS lease_valid
         FROM spool.attempts
        WHERE work_id = $1 AND pi_session_id = $2 AND runtime_id = $3
          AND state = 'active'
        FOR UPDATE`,
      [binding.workId, identity.piSessionId, identity.runtimeId],
    );
    const attempt = result.rows[0];
    if (!attempt) {
      const otherRuntime = await client.query(
        `SELECT 1 FROM spool.attempts
          WHERE work_id = $1 AND pi_session_id = $2 AND state = 'active'
          LIMIT 1`,
        [binding.workId, identity.piSessionId],
      );
      throw new LostOwnershipError(
        otherRuntime.rowCount
          ? "active attempt belongs to an earlier extension runtime; inspect and reclaim after ownership ends"
          : "current session/runtime has no active attempt; inspect and claim",
      );
    }
    if (!attempt.lease_valid) {
      throw new LostOwnershipError(
        "locally recorded lease has expired; inspect and reclaim instead of renewing or mutating",
      );
    }
    return attempt;
  }

  private async reconcileEndedExpiredAttempts(
    client: PoolClient,
    sdk: Absurd,
    prioritizePiSessionId: string,
  ): Promise<void> {
    const expired = await client.query<{
      attempt_id: string;
      absurd_task_id: string;
    }>(
      `SELECT a.attempt_id, a.absurd_task_id
         FROM spool.attempts a
         JOIN spool.works w ON w.work_id = a.work_id
        WHERE w.queue_name = $1 AND a.state = 'active'
          AND a.lease_expires_at <= absurd.current_time()
        ORDER BY CASE WHEN a.pi_session_id = $2 THEN 0 ELSE 1 END,
                 a.lease_expires_at, a.attempt_id
        LIMIT 20
        FOR UPDATE OF a`,
      [this.queueName, prioritizePiSessionId],
    );
    for (const attempt of expired.rows) {
      const snapshot = await sdk.fetchTaskResult(attempt.absurd_task_id, {
        queue: this.queueName,
      });
      if (snapshot && snapshot.state !== "running") {
        await client.query(
          `UPDATE spool.attempts
              SET state = 'lost',
                  last_transition = 'lease_expired_swept',
                  last_summary = 'Absurd ended the expired run; claim again for its queued replacement',
                  updated_at = absurd.current_time()
            WHERE attempt_id = $1 AND state = 'active'`,
          [attempt.attempt_id],
        );
      }
    }
  }

  private async databaseNow(client: PoolClient): Promise<Date> {
    const result = await client.query<{ now: Date }>(
      "SELECT absurd.current_time() AS now",
    );
    return result.rows[0]!.now;
  }

  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    beginSql = "BEGIN",
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw spoolUserFacingError(error);
    }

    let transactionStarted = false;
    let commitAttempted = false;
    let discardClient = false;
    try {
      await client.query(beginSql);
      transactionStarted = true;
      const result = await operation(client);
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      const databaseFailure = isDatabaseFailure(error);
      let rollbackFailed = false;
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          rollbackFailed = true;
        }
      }
      if (commitAttempted) {
        discardClient = true;
        throw new SpoolDatabaseError(
          "Spool lost the database commit acknowledgement; the durable outcome is uncertain. Inspect Spool state before retrying and do not automatically repeat the mutation.",
        );
      }
      if (rollbackFailed) {
        discardClient = true;
        throw new SpoolDatabaseError(
          "Spool could not confirm database rollback; the durable outcome is uncertain. Inspect Spool state before retrying and do not treat tracking as unavailable.",
        );
      }
      discardClient = databaseFailure;
      throw spoolUserFacingError(error);
    } finally {
      client.release(discardClient);
    }
  }
}

export function spoolUserFacingError(error: unknown): Error {
  if (error instanceof SpoolDatabaseError) return error;
  if (!isDatabaseFailure(error)) {
    return error instanceof Error ? error : new Error("Unknown Spool failure");
  }
  return new SpoolDatabaseError(
    "Spool database operation failed or timed out. Start the configured Docker Compose database if it is stopped, then inspect durable Spool state before retrying any mutation; Spool never retries automatically.",
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
      new Set([
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
        "ENETUNREACH",
        "EHOSTUNREACH",
      ]).has(candidate.code)
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

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
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

function deriveWorkId(
  queueName: string,
  input: { vault: string; taskId: string; canonicalPath: string },
): string {
  const digest = createHash("sha256")
    .update(`${queueName}\0${input.vault}\0${input.taskId}\0${input.canonicalPath}`)
    .digest("hex")
    .slice(0, 24);
  return `work_${digest}`;
}

function workerId(identity: RuntimeIdentity): string {
  return `spool:${identity.runtimeId}:${identity.piSessionId}`;
}

function jsonObject(value: JsonValue): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function jsonString(value: JsonValue, key: string): string | null {
  const object = jsonObject(value);
  const field = object?.[key];
  return typeof field === "string" ? field : null;
}

function mapWork(row: {
  work_id: string;
  queue_name: string;
  vault: string;
  pkm_task_id: string;
  canonical_path: string;
  outcome: string;
}): WorkRecord {
  return {
    workId: row.work_id,
    queueName: row.queue_name,
    vault: row.vault,
    taskId: row.pkm_task_id,
    canonicalPath: row.canonical_path,
    outcome: row.outcome,
  };
}

function deriveNextAction(steps: ResumePacket["steps"]): string {
  if (steps.length === 0) return "Materialize one consequential step";

  const owned = steps.find(
    (step) => step.latestAttempt?.ownedByCurrentRuntime,
  );
  if (owned) {
    return (
      owned.latestAttempt?.nextAction ??
      `Continue step ${owned.stepId} within this runtime's current lease`
    );
  }

  const attributedExpired = steps.find(
    (step) =>
      step.latestAttempt?.attributedToCurrentRuntime &&
      !step.latestAttempt.leaseValid,
  );
  if (attributedExpired) {
    return `Inspect queue and explicitly reclaim step ${attributedExpired.stepId}`;
  }

  const reportedInProgress = steps.find(
    (step) => step.state === "reported_in_progress_untracked",
  );
  if (reportedInProgress) {
    return (
      reportedInProgress.report?.nextAction ??
      `Continue step ${reportedInProgress.stepId} as reported untracked execution`
    );
  }

  const running = steps.find((step) => step.state === "running");
  if (running) {
    if (running.latestAttempt?.leaseValid) {
      return `Wait for step ${running.stepId} ownership to end; restored lineage does not convey its lease`;
    }
    return `Inspect queue and explicitly reclaim step ${running.stepId}`;
  }

  const ready = steps.find((step) => step.state === "ready");
  if (ready) return `Claim next ready queue item; expect step ${ready.stepId}`;
  return "Execution is complete; reviewed acceptance is not recorded";
}

export function boundResumePacket(packet: ResumePacket): ResumePacket {
  let truncatedTextFields = packet.omissions.textFields;
  const fit = (value: string | null, maxBytes: number): string | null => {
    if (value === null) return null;
    const truncated = truncateUtf8(value, maxBytes);
    if (truncated !== value) truncatedTextFields += 1;
    return truncated;
  };
  const bounded: ResumePacket = {
    ...packet,
    goal: {
      ...packet.goal,
      canonicalPath: fit(packet.goal.canonicalPath, 2_000)!,
      outcome: fit(packet.goal.outcome, 500)!,
    },
    steps: packet.steps.map((step) => ({
      ...step,
      title: fit(step.title, 200)!,
      contribution: fit(step.contribution, 500)!,
      criteria: fit(step.criteria, 500)!,
      report: step.report
        ? {
            ...step.report,
            summary: fit(step.report.summary, 500)!,
            evidenceRef: fit(step.report.evidenceRef, 1_000)!,
            nextAction: fit(step.report.nextAction, 500),
            reporterPiSessionName: fit(step.report.reporterPiSessionName, 200),
          }
        : null,
      latestAttempt: step.latestAttempt
        ? {
            ...step.latestAttempt,
            piSessionName: fit(step.latestAttempt.piSessionName, 200),
            lastSummary: fit(step.latestAttempt.lastSummary, 500),
            nextAction: fit(step.latestAttempt.nextAction, 500),
          }
        : null,
      checkpoints: step.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        evidenceRef: fit(checkpoint.evidenceRef, 1_000),
      })),
    })),
    nextAction: fit(packet.nextAction, 500)!,
    omissions: { ...packet.omissions, textFields: truncatedTextFields },
  };
  if (
    bounded.omissions.steps > 0 &&
    bounded.nextAction.startsWith("Execution is complete")
  ) {
    bounded.nextAction =
      "Inspect omitted steps before concluding that execution is complete";
  }

  while (resumePacketBytes(bounded) > MAX_RESUME_PACKET_BYTES) {
    let removedCheckpoint = false;
    for (let index = bounded.steps.length - 1; index >= 0; index -= 1) {
      const checkpoints = bounded.steps[index]!.checkpoints;
      if (checkpoints.length > 0) {
        checkpoints.pop();
        bounded.omissions.checkpoints += 1;
        removedCheckpoint = true;
        break;
      }
    }
    if (!removedCheckpoint) {
      if (bounded.steps.length <= 1) {
        throw new Error("bounded resume packet cannot fit its required goal/active step");
      }
      bounded.steps.pop();
      bounded.omissions.steps += 1;
    }
    bounded.omissions.notice = omissionNotice(
      bounded.omissions.steps,
      bounded.omissions.checkpoints,
      bounded.omissions.textFields,
    );
  }

  if (
    bounded.omissions.steps > 0 ||
    bounded.omissions.checkpoints > 0 ||
    bounded.omissions.textFields > 0
  ) {
    bounded.omissions.notice = omissionNotice(
      bounded.omissions.steps,
      bounded.omissions.checkpoints,
      bounded.omissions.textFields,
    );
  }
  return bounded;
}

export function resumePacketBytes(packet: ResumePacket): number {
  return Buffer.byteLength(JSON.stringify(packet), "utf8");
}

function omissionNotice(
  steps: number,
  checkpoints: number,
  textFields: number,
): string {
  return `Bounded view omitted ${steps} step(s), ${checkpoints} checkpoint(s), and truncated ${textFields} text field(s); inspect durable state with a narrower future query before claiming completeness.`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "...";
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + suffix.length > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result + suffix;
}

const quietLog = {
  log() {},
  info() {},
  warn() {},
  error() {},
};
