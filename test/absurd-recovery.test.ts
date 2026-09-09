import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { JsonValue } from "absurd-sdk";
import { Pool } from "pg";
import {
  AbsurdRecoveryAdapter,
  type ClaimedStep,
  type PiSessionCorrelation,
} from "../src/absurd-recovery-adapter.ts";

const queueName = "spool_recovery_probe";
const baseTime = new Date("2026-09-08T09:00:00.000Z");
const expectedSchemaSha256 =
  "d34309370c539f3a51f2b36b69b1f77551f8e4a14480a1c8def8bb8f40fd9aab";
const schemaSql = readFileSync(
  new URL("./fixtures/absurd-0.5.0.sql", import.meta.url),
  "utf8",
);

async function setFakeNow(db: Pool, time: Date): Promise<void> {
  await db.query("SELECT set_config('absurd.fake_now', $1, false)", [
    time.toISOString(),
  ]);
}

async function expectFailedAttempt(operation: () => Promise<void>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code: string }).code === "AB002"
    );
  });
}

function session(
  piSessionId: string,
  attemptId: string,
): PiSessionCorrelation {
  return {
    piSessionId,
    piSessionName: `simulated-${piSessionId}`,
    piSessionFile: `/tmp/${piSessionId}.jsonl`,
    attemptId,
  };
}

async function reuseOrCreateCheckpoint<T extends JsonValue>(
  adapter: AbsurdRecoveryAdapter,
  claim: ClaimedStep,
  name: string,
  effect: () => T,
): Promise<T> {
  const existing = (await adapter.readCheckpoints(claim)).find(
    (checkpoint) => checkpoint.name === name,
  );
  if (existing) return existing.state as T;

  const value = effect();
  await adapter.writeCheckpoint(claim, name, value);
  return value;
}

test(
  "checkpoint survives worker loss and stale attempt is fenced after takeover",
  { timeout: 120_000 },
  async () => {
    assert.equal(
      createHash("sha256").update(schemaSql).digest("hex"),
      expectedSchemaSha256,
      "vendored release schema must match its recorded provenance",
    );

    const container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const db = new Pool({
      connectionString: container.getConnectionUri(),
      max: 1,
    });
    let adapter: AbsurdRecoveryAdapter | undefined;

    try {
      await db.query(schemaSql);
      const schemaVersion = await db.query<{ version: string }>(
        "SELECT absurd.get_schema_version() AS version",
      );
      assert.equal(schemaVersion.rows[0]?.version, "0.5.0");
      adapter = new AbsurdRecoveryAdapter(db, queueName);
      await adapter.createQueue();
      await setFakeNow(db, baseTime);

      const spawnA = await adapter.spawnStep(
        "materialized-step",
        { workId: "ALD-1", stepId: "recovery-proof" },
        {
          idempotencyKey: "ALD-1:recovery-proof",
          maxAttempts: 2,
          headers: { workId: "ALD-1", stepId: "recovery-proof" },
        },
      );
      const duplicateSpawn = await adapter.spawnStep(
        "materialized-step",
        { workId: "ALD-1", stepId: "changed-input-is-ignored" },
        { idempotencyKey: "ALD-1:recovery-proof", maxAttempts: 2 },
      );

      assert.equal(spawnA.created, true);
      assert.equal(duplicateSpawn.created, false);
      assert.equal(duplicateSpawn.taskId, spawnA.taskId);
      assert.equal(duplicateSpawn.runId, spawnA.runId);
      assert.equal(duplicateSpawn.attempt, 1);
      assert.notEqual(spawnA.taskId, spawnA.runId);
      const taskCount = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM absurd.t_${queueName}`,
      );
      assert.equal(taskCount.rows[0]?.count, "1");

      const sessionA = session("pi-session-A", "spool-attempt-A");
      const claimA = await adapter.claimNext(sessionA, 30);
      assert.ok(claimA);
      assert.equal(claimA.taskId, spawnA.taskId);
      assert.equal(claimA.runId, spawnA.runId);
      assert.equal(claimA.attempt, 1);
      assert.deepEqual(claimA.correlation, sessionA);
      assert.match(claimA.workerId, /spool-attempt-A:pi-session-A$/);

      const runA = await db.query<{ claimed_by: string }>(
        `SELECT claimed_by FROM absurd.r_${queueName} WHERE run_id = $1`,
        [claimA.runId],
      );
      assert.equal(runA.rows[0]?.claimed_by, claimA.workerId);

      assert.equal(
        await adapter.claimNext(session("pi-competitor", "competitor"), 30),
        null,
        "a competing session cannot claim before lease expiry",
      );

      let countedFixtureEffects = 0;
      const fixtureValue = await reuseOrCreateCheckpoint(
        adapter,
        claimA,
        "costly-fixture",
        () => ({ digest: "fixture-v1", ordinal: ++countedFixtureEffects }),
      );

      const checkpointsA = await adapter.readCheckpoints(claimA);
      assert.deepEqual(
        checkpointsA.find((checkpoint) => checkpoint.name === "costly-fixture")?.state,
        fixtureValue,
      );

      // Absurd's expiry timestamp is not itself a fencing transition. Until a
      // later claim sweeps this run, the expired run remains `running`; this
      // test proves checkpoint and heartbeat still accept it.
      const justAfterOriginalExpiry = new Date(baseTime.getTime() + 31_000);
      await setFakeNow(db, justAfterOriginalExpiry);
      await adapter.writeCheckpoint(claimA, "expired-before-sweep", {
        observed: true,
      });
      await adapter.heartbeat(claimA, 20);
      assert.equal(
        await adapter.claimNext(session("pi-too-early", "too-early"), 30),
        null,
        "the expired run resurrected by a pre-sweep heartbeat remains claimed",
      );

      // Let the renewed lease expire. claim_task performs the timeout sweep,
      // fails run A, creates attempt 2, and claims that replacement run.
      await setFakeNow(db, new Date(baseTime.getTime() + 52_000));
      const sessionB = session("pi-session-B", "spool-attempt-B");
      const claimB = await adapter.claimNext(sessionB, 30);
      assert.ok(claimB);
      assert.equal(claimB.taskId, claimA.taskId);
      assert.notEqual(claimB.runId, claimA.runId);
      assert.equal(claimB.attempt, 2);
      assert.deepEqual(claimB.correlation, sessionB);

      const recoveredFixture = await reuseOrCreateCheckpoint(
        adapter,
        claimB,
        "costly-fixture",
        () => ({ digest: "fixture-v1", ordinal: ++countedFixtureEffects }),
      );
      assert.deepEqual(recoveredFixture, fixtureValue);
      assert.equal(countedFixtureEffects, 1, "replacement reuses the effect checkpoint");

      await expectFailedAttempt(() =>
        adapter!.writeCheckpoint(claimA, "stale-write", { accepted: false }),
      );
      await expectFailedAttempt(() => adapter!.heartbeat(claimA, 30));
      await expectFailedAttempt(() =>
        adapter!.complete(claimA, { stale: true }),
      );

      await adapter.complete(claimB, {
        checkpoint: recoveredFixture,
        completedBy: sessionB.piSessionId,
      });
      assert.deepEqual(await adapter.fetchTaskResult(claimB.taskId), {
        state: "completed",
        result: {
          checkpoint: fixtureValue,
          completedBy: "pi-session-B",
        },
        failureReason: null,
      });

      await assert.rejects(
        () => adapter!.complete(claimB, { duplicate: true }),
        /not currently running/,
        "Absurd completion rejects duplicate settlement; it does not deduplicate business evidence acceptance",
      );
    } finally {
      if (adapter) {
        await adapter.dropQueue().catch(() => undefined);
      }
      await db.end().catch(() => undefined);
      await container.stop();
    }
  },
);
