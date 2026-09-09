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
