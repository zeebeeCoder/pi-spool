import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPOOL_CLOSE_TIMEOUT_MS,
  SPOOL_CONNECTION_TIMEOUT_MS,
  SPOOL_QUERY_TIMEOUT_MS,
  SPOOL_STATEMENT_TIMEOUT_MS,
  SpoolDatabaseError,
  SpoolService,
} from "../src/spool-service.ts";

test("unreachable database fails within the connection bound without secret echo", async () => {
  const service = SpoolService.connect({
    databaseUrl:
      "postgresql://spool:TOPSECRET@127.0.0.1:1/spool?application_name=pi-spool-test",
    queueName: "spool_unreachable",
  });
  const startedAt = Date.now();
  try {
    await assert.rejects(
      service.attach(
        {
          vault: "vault",
          taskId: "FAIL-1",
          canonicalPath: "/vault/FAIL-1.md",
          outcome: "fail fast without Docker",
        },
        {
          piSessionId: "session-failure",
          runtimeId: "11111111-1111-4111-8111-111111111111",
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof SpoolDatabaseError);
        assert.match(error.message, /Start the configured Docker Compose database/);
        assert.match(error.message, /inspect durable Spool state/i);
        assert.match(error.message, /never retries automatically/);
        assert.doesNotMatch(error.message, /TOPSECRET|postgresql:\/\//);
        return true;
      },
    );
    assert.ok(
      Date.now() - startedAt < SPOOL_CONNECTION_TIMEOUT_MS + 2_000,
      "unreachable connection exceeded its advertised bound",
    );
  } finally {
    await service.close();
  }
});

test("rollback uncertainty never becomes soft queue-head unavailability", async () => {
  const queries: string[] = [];
  let releasedWithError: boolean | undefined;
  const headTaskId = "11111111-1111-4111-8111-111111111111";
  const intendedTaskId = "22222222-2222-4222-8222-222222222222";
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      if (sql === "ROLLBACK") {
        throw Object.assign(new Error("rollback transport secret"), {
          code: "ECONNRESET",
        });
      }
      if (sql.startsWith("SELECT 1 FROM spool.works")) {
        return { rows: [{}], rowCount: 1 };
      }
      if (sql.includes("FROM spool.attempts") && sql.includes("pi_session_id = $1")) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("FROM spool.attempts") &&
        sql.includes("work_id = $1 AND step_id = $2")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT absurd.current_time() AS now")) {
        return { rows: [{ now: new Date("2026-09-09T12:00:00Z") }], rowCount: 1 };
      }
      if (sql.includes("SELECT s.title")) {
        const workId = String(params[0]);
        return {
          rows: [
            {
              title: "Ready",
              contribution: "test",
              completion_criteria: "hard rollback failure",
              absurd_task_id:
                workId === "work-head" ? headTaskId : intendedTaskId,
              state: "ready",
              queue_name: "spool_rollback_failure",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql === "BEGIN") return { rows: [], rowCount: null };
      throw new Error(`unexpected test query: ${sql}`);
    },
    release(error: boolean) {
      releasedWithError = error;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  const service = new SpoolService(
    pool as unknown as ConstructorParameters<typeof SpoolService>[0],
    "spool_rollback_failure",
  );
  Object.defineProperty(service, "sdk", {
    value: {
      bindToConnection() {
        return {
          async fetchTaskResult() {
            return { state: "pending" };
          },
          async claimTasks() {
            return [
              {
                task_id: headTaskId,
                task_name: "spool-step",
                params: {
                  kind: "spool-step",
                  workId: "work-head",
                  stepId: "head-step",
                },
                run_id: "33333333-3333-4333-8333-333333333333",
                attempt: 1,
              },
            ];
          },
        };
      },
    },
  });

  await assert.rejects(
    service.claimNext(
      {
        version: 1,
        workId: "work-intended",
        vault: "vault",
        taskId: "INTENDED-1",
        canonicalPath: "/vault/INTENDED-1.md",
      },
      {
        piSessionId: "session-intended",
        runtimeId: "44444444-4444-4444-8444-444444444444",
      },
      { expectedStepId: "intended-step", leaseSeconds: 10 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SpoolDatabaseError);
      assert.match(error.message, /could not confirm database rollback/i);
      assert.match(error.message, /do not treat tracking as unavailable/i);
      assert.doesNotMatch(error.message, /transport secret/);
      return true;
    },
  );
  assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 1);
  assert.equal(releasedWithError, true);
});

test("owned pool advertises finite connection, statement, query, and close bounds", async () => {
  const service = SpoolService.connect({
    databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unused",
    queueName: "spool_timeout_options",
  });
  const pool = (
    service as unknown as {
      pool: {
        options: Record<string, unknown>;
      };
    }
  ).pool;
  try {
    assert.equal(
      pool.options.connectionTimeoutMillis,
      SPOOL_CONNECTION_TIMEOUT_MS,
    );
    assert.equal(pool.options.statement_timeout, SPOOL_STATEMENT_TIMEOUT_MS);
    assert.equal(pool.options.query_timeout, SPOOL_QUERY_TIMEOUT_MS);
    assert.equal(
      pool.options.idle_in_transaction_session_timeout,
      SPOOL_STATEMENT_TIMEOUT_MS,
    );
    assert.ok(SPOOL_CLOSE_TIMEOUT_MS > SPOOL_QUERY_TIMEOUT_MS);
  } finally {
    await service.close();
  }
});
