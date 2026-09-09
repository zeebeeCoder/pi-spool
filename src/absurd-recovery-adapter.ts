import { Absurd, type JsonObject, type JsonValue } from "absurd-sdk";
import type { Pool } from "pg";

export interface PiSessionCorrelation {
  piSessionId: string;
  piSessionName?: string;
  piSessionFile?: string;
  attemptId: string;
}

export interface SpawnedStep {
  taskId: string;
  runId: string;
  attempt: number;
  created: boolean;
}

export interface ClaimedStep {
  taskId: string;
  runId: string;
  attempt: number;
  taskName: string;
  params: JsonValue;
  headers: JsonObject | null;
  workerId: string;
  correlation: PiSessionCorrelation;
}

export interface Checkpoint<T extends JsonValue = JsonValue> {
  name: string;
  state: T;
  status: string;
  ownerRunId: string | null;
  updatedAt: Date;
}

export interface TaskResult {
  state:
    | "pending"
    | "running"
    | "sleeping"
    | "completed"
    | "failed"
    | "cancelled";
  result: JsonValue | null;
  failureReason: JsonValue | null;
}

function asJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function workerId(correlation: PiSessionCorrelation): string {
  // This is correlation metadata, not authentication or authorization.
  return `spool:${correlation.attemptId}:${correlation.piSessionId}`;
}

/**
 * Thin adapter for the recovery experiment.
 *
 * Queue creation, spawn, claim, and result lookup use absurd-sdk@0.5.0.
 * Heartbeat and checkpoints are exposed only on handler-owned TaskContext, and
 * the SDK has no public completion method, so those remain public-SQL calls.
 *
 * claimNext intentionally mirrors Absurd's queue-wide claim semantics. It cannot
 * nominate a task ID, and callers must not treat Pi session metadata as proof of
 * identity or lease ownership.
 */
export class AbsurdRecoveryAdapter {
  private readonly db: Pool;
  private readonly sdk: Absurd;
  readonly queueName: string;

  constructor(db: Pool, queueName: string) {
    this.db = db;
    this.queueName = queueName;
    this.sdk = new Absurd({
      db,
      queueName,
      log: {
        log() {},
        info() {},
        warn() {},
        error() {},
      },
    });
  }

  async createQueue(): Promise<void> {
    await this.sdk.createQueue(this.queueName, { storageMode: "unpartitioned" });
  }

  async dropQueue(): Promise<void> {
    await this.sdk.dropQueue(this.queueName);
  }

  async spawnStep(
    taskName: string,
    params: JsonValue,
    options: {
      idempotencyKey: string;
      maxAttempts?: number;
      headers?: JsonObject;
    },
  ): Promise<SpawnedStep> {
    const spawned = await this.sdk.spawn(taskName, params, {
      queue: this.queueName,
      idempotencyKey: options.idempotencyKey,
      maxAttempts: options.maxAttempts ?? 2,
      retryStrategy: { kind: "none" },
      headers: options.headers,
    });
    return {
      taskId: spawned.taskID,
      runId: spawned.runID,
      attempt: spawned.attempt,
      created: spawned.created,
    };
  }

  async claimNext(
    correlation: PiSessionCorrelation,
    claimSeconds: number,
  ): Promise<ClaimedStep | null> {
    const claimedBy = workerId(correlation);
    const row = (
      await this.sdk.claimTasks({
        workerId: claimedBy,
        claimTimeout: claimSeconds,
        batchSize: 1,
      })
    )[0];
    if (!row) return null;
    return {
      taskId: row.task_id,
      runId: row.run_id,
      attempt: row.attempt,
      taskName: row.task_name,
      params: row.params,
      headers: row.headers,
      workerId: claimedBy,
      correlation: { ...correlation },
    };
  }

  async writeCheckpoint(
    claim: Pick<ClaimedStep, "taskId" | "runId">,
    name: string,
    state: JsonValue,
  ): Promise<void> {
    await this.db.query(
      "SELECT absurd.set_task_checkpoint_state($1, $2, $3, $4, $5)",
      [this.queueName, claim.taskId, name, asJson(state), claim.runId],
    );
  }

  async readCheckpoints(
    claim: Pick<ClaimedStep, "taskId" | "runId">,
  ): Promise<Checkpoint[]> {
    const result = await this.db.query<{
      checkpoint_name: string;
      state: JsonValue;
      status: string;
      owner_run_id: string | null;
      updated_at: Date;
    }>(
      `SELECT checkpoint_name, state, status, owner_run_id, updated_at
         FROM absurd.get_task_checkpoint_states($1, $2, $3)`,
      [this.queueName, claim.taskId, claim.runId],
    );
    return result.rows.map((row) => ({
      name: row.checkpoint_name,
      state: row.state,
      status: row.status,
      ownerRunId: row.owner_run_id,
      updatedAt: row.updated_at,
    }));
  }

  async heartbeat(
    claim: Pick<ClaimedStep, "runId">,
    seconds: number,
  ): Promise<void> {
    await this.db.query("SELECT absurd.extend_claim($1, $2, $3)", [
      this.queueName,
      claim.runId,
      seconds,
    ]);
  }

  async complete(
    claim: Pick<ClaimedStep, "runId">,
    result: JsonValue,
  ): Promise<void> {
    await this.db.query("SELECT absurd.complete_run($1, $2, $3)", [
      this.queueName,
      claim.runId,
      asJson(result),
    ]);
  }

  async fetchTaskResult(taskId: string): Promise<TaskResult | null> {
    const snapshot = await this.sdk.fetchTaskResult(taskId, {
      queue: this.queueName,
    });
    if (!snapshot) return null;

    if (snapshot.state === "completed") {
      return {
        state: snapshot.state,
        result: snapshot.result,
        failureReason: null,
      };
    }
    if (snapshot.state === "failed") {
      return {
        state: snapshot.state,
        result: null,
        failureReason: snapshot.failure,
      };
    }
    return {
      state: snapshot.state,
      result: null,
      failureReason: null,
    };
  }
}
