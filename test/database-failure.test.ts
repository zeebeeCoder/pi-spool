import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SPOOL_CLOSE_TIMEOUT_MS,
  SPOOL_CONNECTION_TIMEOUT_MS,
  SPOOL_QUERY_TIMEOUT_MS,
  SPOOL_STATEMENT_TIMEOUT_MS,
  SpoolDatabaseError,
  SpoolService,
  createBoundedSpoolPool,
} from "../src/spool-service.ts";

const binding = {
  version: 1 as const,
  workId: "work_x",
  vault: "v",
  taskId: "T-1",
  canonicalPath: "/v/tasks/T-1.md",
};
const identity = {
  piSessionId: "s",
  piSessionName: null,
  piSessionFile: null,
  runtimeId: "11111111-1111-4111-8111-111111111111",
};

test("unreachable database fails within the connection bound without secret echo", async () => {
  const service = SpoolService.connect({
    databaseUrl: "postgresql://user:hunter2@127.0.0.1:1/spool",
  });
  const started = Date.now();
  try {
    await assert.rejects(
      service.note(binding, identity, { stepId: "s1", summary: "x" }),
      (error: Error) =>
        error instanceof SpoolDatabaseError &&
        !error.message.includes("hunter2") &&
        /work is not affected/.test(error.message),
    );
    await assert.rejects(
      service.resume(binding, identity),
      (error: Error) => error instanceof SpoolDatabaseError && !error.message.includes("hunter2"),
    );
  } finally {
    await service.close();
  }
  assert.ok(Date.now() - started < SPOOL_CONNECTION_TIMEOUT_MS * 3);
});

test("owned pool advertises finite bounds", async () => {
  const pool = createBoundedSpoolPool("postgresql://user:pw@127.0.0.1:1/spool");
  try {
    const options = pool.options as unknown as Record<string, unknown>;
    assert.equal(options.connectionTimeoutMillis, SPOOL_CONNECTION_TIMEOUT_MS);
    assert.equal(options.statement_timeout, SPOOL_STATEMENT_TIMEOUT_MS);
    assert.equal(options.query_timeout, SPOOL_QUERY_TIMEOUT_MS);
    assert.ok(SPOOL_CLOSE_TIMEOUT_MS > 0);
  } finally {
    await pool.end();
  }
});
