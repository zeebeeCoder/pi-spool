import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Absurd } from "absurd-sdk";
import { Pool } from "pg";
import type { SessionBinding } from "../src/binding.ts";
import {
  ClaimConflictError,
  LostOwnershipError,
  SpoolService,
  type RuntimeIdentity,
} from "../src/spool-service.ts";

const absurdSql = readFileSync(
  new URL("./fixtures/absurd-0.5.0.sql", import.meta.url),
  "utf8",
);
const spoolSql = readFileSync(new URL("../sql/spool.sql", import.meta.url), "utf8");

function identity(session: string, runtime: string): RuntimeIdentity {
  return {
    piSessionId: session,
    piSessionName: `name-${session}`,
    piSessionFile: `/sessions/${session}.jsonl`,
    runtimeId: runtime,
  };
}

function binding(work: Awaited<ReturnType<SpoolService["attach"]>>): SessionBinding {
  return {
    version: 1,
    workId: work.workId,
    vault: work.vault,
    taskId: work.taskId,
    canonicalPath: work.canonicalPath,
  };
}

async function withHarness(
  queueName: string,
  run: (pool: Pool, service: SpoolService) => Promise<void>,
): Promise<void> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  const sdk = new Absurd({ db: pool, queueName });
  try {
    await pool.query(absurdSql);
    await pool.query(spoolSql);
    await sdk.createQueue(queueName, { storageMode: "unpartitioned" });
    await run(pool, new SpoolService(pool, queueName));
  } finally {
    await sdk.dropQueue(queueName).catch(() => undefined);
    await pool.end().catch(() => undefined);
    await container.stop();
  }
}

test(
  "attach through execution completion reconstructs from durable state",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_loop", async (pool, service) => {
      const owner = identity(
        "session-a",
        "11111111-1111-4111-8111-111111111111",
      );
      const work = await service.attach(
        {
          vault: "zeebs_sb",
          taskId: "ALD-1",
          canonicalPath: "/vault/tasks/ALD-1.md",
          outcome: "prove a resumable execution loop",
        },
        owner,
      );
      const attached = binding(work);
      const first = await service.materialize(attached, {
        stepId: "verify-loop",
        title: "Verify loop",
        contribution: "prove durable continuation",
        criteria: "checkpoint is visible after reconstruction",
      });
      const retry = await service.materialize(attached, {
        stepId: "verify-loop",
        title: "Verify loop",
        contribution: "prove durable continuation",
        criteria: "checkpoint is visible after reconstruction",
      });
      assert.equal(first.created, true);
      assert.equal(retry.created, false);
      assert.equal(retry.taskId, first.taskId);

      const claimed = await service.claimNext(attached, owner, {
        expectedStepId: "verify-loop",
        leaseSeconds: 10,
      });
      assert.ok(claimed);
      const atomic = await pool.query<{ attempts: string; task_state: string }>(
        `SELECT
           (SELECT count(*)::text FROM spool.attempts WHERE absurd_run_id = $1) AS attempts,
           (SELECT state FROM absurd.t_spool_loop WHERE task_id = $2) AS task_state`,
        [claimed.runId, claimed.taskId],
      );
      assert.deepEqual(atomic.rows[0], { attempts: "1", task_state: "running" });

      await service.materialize(attached, {
        stepId: "future-step",
        title: "Future step",
        contribution: "remain ready without distracting from active work",
        criteria: "run only after verify-loop",
      });
      await service.checkpoint(attached, owner, {
        checkpointName: "fixture-ready",
        evidenceRef: "sha256:fixture-v1",
        nextAction: "finish deterministic verification",
      });
      const ownerPacket = await service.resume(attached, owner);
      assert.equal(ownerPacket.steps[0]?.stepId, "verify-loop");
      assert.equal(ownerPacket.steps[0]?.latestAttempt?.ownedByCurrentRuntime, true);
      assert.equal(ownerPacket.nextAction, "finish deterministic verification");

      const fresh = new SpoolService(pool, "spool_loop");
      const reloadedIdentity = identity(
        "session-a",
        "22222222-2222-4222-8222-222222222222",
      );
      const packet = await fresh.resume(attached, reloadedIdentity);
      assert.equal(packet.goal.taskId, "ALD-1");
      assert.equal(packet.steps[0]?.stepId, "verify-loop");
      assert.equal(packet.steps[0]?.latestAttempt?.ownedByCurrentRuntime, false);
      assert.match(packet.nextAction, /restored lineage does not convey its lease/);
      assert.deepEqual(packet.steps[0]?.checkpoints, [
        {
          name: "fixture-ready",
          evidenceRef: "sha256:fixture-v1",
          recordedAt: packet.steps[0]?.checkpoints[0]?.recordedAt ?? null,
        },
      ]);
      assert.equal(packet.acceptance, "not_recorded");

      await assert.rejects(
        fresh.completeExecution(attached, reloadedIdentity, {
          resultRef: "git:abc",
          summary: "must not complete",
        }),
        LostOwnershipError,
      );
      await assert.rejects(
        fresh.checkpoint(
          attached,
          identity(
            "session-other",
            "33333333-3333-4333-8333-333333333333",
          ),
          { checkpointName: "foreign", evidenceRef: "none" },
        ),
        LostOwnershipError,
      );
      await assert.rejects(
        fresh.claimNext(attached, reloadedIdentity, {
          expectedStepId: "future-step",
          leaseSeconds: 10,
        }),
        LostOwnershipError,
      );
      await assert.rejects(
        fresh.attach(
          {
            vault: "zeebs_sb",
            taskId: "OTHER-1",
            canonicalPath: "/vault/tasks/OTHER-1.md",
            outcome: "must not replace an active binding",
          },
          reloadedIdentity,
        ),
        /different active attempt/,
      );

      const renewedUntil = await service.heartbeat(attached, owner, 10);
      assert.ok(renewedUntil.getTime() > Date.now());
      await service.completeExecution(attached, owner, {
        resultRef: "git:abc",
        summary: "deterministic loop verified",
      });
      const future = await service.claimNext(attached, owner, {
        expectedStepId: "future-step",
        leaseSeconds: 10,
      });
      assert.ok(future);
      await service.completeExecution(attached, owner, {
        resultRef: "git:def",
        summary: "future step also complete",
      });
      const completed = await fresh.resume(attached, reloadedIdentity);
      assert.equal(completed.steps[0]?.state, "execution_completed");
      assert.equal(completed.acceptance, "not_recorded");
      assert.match(completed.nextAction, /acceptance is not recorded/);
      await assert.rejects(
        service.completeExecution(attached, owner, {
          resultRef: "git:abc",
          summary: "duplicate",
        }),
        LostOwnershipError,
      );
    });
  },
);

test(
  "queue-head mismatch rolls back claim without stealing or stranding either task",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_conflict", async (_pool, service) => {
      const identityA = identity(
        "session-a",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      const identityB = identity(
        "session-b",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      );
      const workA = await service.attach(
        {
          vault: "vault",
          taskId: "A-1",
          canonicalPath: "/vault/A-1.md",
          outcome: "first queue item",
        },
        identityA,
      );
      const workB = await service.attach(
        {
          vault: "vault",
          taskId: "B-1",
          canonicalPath: "/vault/B-1.md",
          outcome: "second queue item",
        },
        identityB,
      );
      const bindingA = binding(workA);
      const bindingB = binding(workB);
      await service.materialize(bindingA, {
        stepId: "step-a",
        title: "Step A",
        contribution: "first",
        criteria: "done A",
      });
      await sleep(5);
      await service.materialize(bindingB, {
        stepId: "step-b",
        title: "Step B",
        contribution: "second",
        criteria: "done B",
      });

      await assert.rejects(
        service.claimNext(bindingB, identityB, {
          expectedStepId: "step-b",
          leaseSeconds: 10,
        }),
        ClaimConflictError,
      );
      const afterConflict = await service.resume(bindingA, identityA);
      assert.equal(afterConflict.steps[0]?.state, "ready");
      assert.equal(afterConflict.steps[0]?.latestAttempt, null);

      const claimA = await service.claimNext(bindingA, identityA, {
        expectedStepId: "step-a",
        leaseSeconds: 10,
      });
      assert.ok(claimA);
      await service.completeExecution(bindingA, identityA, {
        resultRef: "result:a",
        summary: "free queue head",
      });
      const claimB = await service.claimNext(bindingB, identityB, {
        expectedStepId: "step-b",
        leaseSeconds: 10,
      });
      assert.ok(claimB);
      assert.equal(claimB.stepId, "step-b");
    });
  },
);

test(
  "same-session concurrent runtimes cannot create two active bindings",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_concurrent", async (pool, service) => {
      const firstIdentity = identity(
        "shared-session",
        "11111111-aaaa-4111-8111-111111111111",
      );
      const secondIdentity = identity(
        "shared-session",
        "22222222-bbbb-4222-8222-222222222222",
      );
      const work = await service.attach(
        {
          vault: "vault",
          taskId: "CON-1",
          canonicalPath: "/vault/CON-1.md",
          outcome: "serialize session ownership in the database",
        },
        firstIdentity,
      );
      const attached = binding(work);
      for (const stepId of ["concurrent-a", "concurrent-b"]) {
        await service.materialize(attached, {
          stepId,
          title: stepId,
          contribution: "exercise concurrent claim",
          criteria: "only one binding commits",
        });
      }

      const results = await Promise.allSettled([
        service.claimNext(attached, firstIdentity, { leaseSeconds: 10 }),
        service.claimNext(attached, secondIdentity, { leaseSeconds: 10 }),
      ]);
      assert.equal(
        results.filter(
          (result) => result.status === "fulfilled" && result.value !== null,
        ).length,
        1,
      );
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const active = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM spool.attempts WHERE state = 'active'",
      );
      const running = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM absurd.r_spool_concurrent WHERE state = 'running'",
      );
      assert.equal(active.rows[0]?.count, "1");
      assert.equal(running.rows[0]?.count, "1");
    });
  },
);

test(
  "bound step survives the 20-step view and omissions prevent false completeness",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_selection", async (_pool, service) => {
      const owner = identity(
        "selection-session",
        "99999999-9999-4999-8999-999999999999",
      );
      const work = await service.attach(
        {
          vault: "vault",
          taskId: "SEL-1",
          canonicalPath: "/vault/SEL-1.md",
          outcome: "keep bound work in a bounded view",
        },
        owner,
      );
      const attached = binding(work);
      for (let index = 0; index < 21; index += 1) {
        await service.materialize(attached, {
          stepId: `selection-${index.toString().padStart(2, "0")}`,
          title: `Selection ${index}`,
          contribution: "test bounded selection",
          criteria: "remain visible when bound",
        });
      }
      for (let index = 0; index < 20; index += 1) {
        const stepId = `selection-${index.toString().padStart(2, "0")}`;
        const claimed = await service.claimNext(attached, owner, {
          expectedStepId: stepId,
          leaseSeconds: 10,
        });
        assert.ok(claimed);
        await service.completeExecution(attached, owner, {
          resultRef: `result:${stepId}`,
          summary: `completed ${stepId}`,
        });
      }
      const active = await service.claimNext(attached, owner, {
        expectedStepId: "selection-20",
        leaseSeconds: 10,
      });
      assert.ok(active);
      const boundToLast: SessionBinding = {
        ...attached,
        stepId: "selection-20",
      };
      const packet = await service.resume(boundToLast, owner);
      assert.ok(packet.steps.length <= 20);
      assert.equal(packet.steps[0]?.stepId, "selection-20");
      assert.equal(packet.steps[0]?.latestAttempt?.ownedByCurrentRuntime, true);
      assert.equal(packet.omissions.steps, 21 - packet.steps.length);
      assert.match(packet.omissions.notice ?? "", /Bounded view omitted/);
      assert.equal(
        packet.nextAction,
        "Checkpoint meaningful progress or complete execution",
      );
    });
  },
);

test(
  "same runtime explicitly reclaims after expiry without resurrecting the old run",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_expiry", async (_pool, service) => {
      const ownerA = identity(
        "session-shared",
        "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      );
      const work = await service.attach(
        {
          vault: "vault",
          taskId: "EXP-1",
          canonicalPath: "/vault/EXP-1.md",
          outcome: "prove runtime fencing",
        },
        ownerA,
      );
      const attached = binding(work);
      await service.materialize(attached, {
        stepId: "expiry-step",
        title: "Expiry step",
        contribution: "reject resurrection",
        criteria: "replacement owns a new run",
      });
      const claimA = await service.claimNext(attached, ownerA, {
        expectedStepId: "expiry-step",
        leaseSeconds: 1,
      });
      assert.ok(claimA);
      await service.checkpoint(attached, ownerA, {
        checkpointName: "before-loss",
        evidenceRef: "sha256:preserved",
        nextAction: "reclaim this step after loss",
      });
      await assert.rejects(
        service.claimNext(attached, ownerA, {
          expectedStepId: "expiry-step",
          leaseSeconds: 1,
        }),
        /valid active Spool attempt/,
      );
      await sleep(2_000);
      const expiredPacket = await service.resume(attached, ownerA);
      assert.equal(
        expiredPacket.steps[0]?.latestAttempt?.ownedByCurrentRuntime,
        false,
      );
      assert.match(expiredPacket.nextAction, /explicitly reclaim step expiry-step/);
      await assert.rejects(service.heartbeat(attached, ownerA, 10), LostOwnershipError);

      const sweep = await service.claimNext(attached, ownerA, {
        expectedStepId: "expiry-step",
        leaseSeconds: 1,
      });
      assert.equal(
        sweep,
        null,
        "with the real clock, the first poll fences the expired run and queues its retry",
      );
      const attachAfterSweep = await service.attach(
        {
          vault: "vault",
          taskId: "EXP-2",
          canonicalPath: "/vault/EXP-2.md",
          outcome: "prove stale local binding no longer blocks attachment",
        },
        ownerA,
      );
      assert.equal(attachAfterSweep.taskId, "EXP-2");
      await service.materialize(attached, {
        stepId: "ready-after-expiry",
        title: "Ready after expiry",
        contribution: "test resume priority",
        criteria: "must not displace recovery guidance",
      });
      const expiredWithReady = await service.resume(attached, ownerA);
      assert.match(
        expiredWithReady.nextAction,
        /explicitly reclaim step expiry-step/,
      );
      const claimB = await service.claimNext(attached, ownerA, {
        expectedStepId: "expiry-step",
        leaseSeconds: 1,
      });
      assert.ok(claimB);
      assert.equal(claimB.attempt, 2);
      assert.notEqual(claimB.runId, claimA.runId);
      const reclaimed = await service.resume(attached, ownerA);
      assert.equal(reclaimed.steps[0]?.latestAttempt?.attempt, 2);
      assert.equal(reclaimed.steps[0]?.latestAttempt?.piSessionId, "session-shared");
      assert.deepEqual(reclaimed.steps[0]?.checkpoints.map((item) => item.name), [
        "before-loss",
      ]);

      await service.heartbeat(attached, ownerA, 1);
      await sleep(2_000);
      await assert.rejects(
        service.checkpoint(attached, ownerA, {
          checkpointName: "expired",
          evidenceRef: "none",
        }),
        LostOwnershipError,
      );

      // The raw Absurd regression separately proves old run A's public-SQL
      // mutations reject after attempt 2 takeover. Tool callers cannot name A's
      // run directly; ownerA now resolves only the current durable attempt.
    });
  },
);
