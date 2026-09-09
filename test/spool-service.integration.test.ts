import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Absurd } from "absurd-sdk";
import { Pool } from "pg";
import type { SessionBinding } from "../src/binding.ts";
import { SpoolDashboardReader } from "../src/dashboard-data.ts";
import {
  ClaimConflictError,
  LostOwnershipError,
  SpoolDatabaseError,
  SpoolService,
  type ClaimedAttempt,
  type ClaimNextResult,
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

function assertClaimed(
  result: ClaimNextResult,
): asserts result is ClaimedAttempt {
  assert.ok(result);
  assert.ok(!("claimed" in result), "expected an acquired claim");
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
      assertClaimed(claimed);
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
  "unrelated NFN-1 head returns typed unavailable without changing either ready task",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_conflict", async (pool, service) => {
      const identityNfn1 = identity(
        "session-nfn1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      const identityNfn3 = identity(
        "session-nfn3",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      );
      const workNfn1 = await service.attach(
        {
          vault: "nfhotel_sb",
          taskId: "NFN-1",
          canonicalPath: "/vault/NFN-1.md",
          outcome: "first ready queue item",
        },
        identityNfn1,
      );
      const workNfn3 = await service.attach(
        {
          vault: "nfhotel_sb",
          taskId: "NFN-3",
          canonicalPath: "/vault/NFN-3.md",
          outcome: "second ready queue item",
        },
        identityNfn3,
      );
      const bindingNfn1 = binding(workNfn1);
      const bindingNfn3 = binding(workNfn3);
      const nfn1Step = await service.materialize(bindingNfn1, {
        stepId: "nfn1-ready",
        title: "NFN-1 ready",
        contribution: "remain first",
        criteria: "unchanged after mismatch",
      });
      await sleep(5);
      const nfn3Step = await service.materialize(bindingNfn3, {
        stepId: "nfn3-ready",
        title: "NFN-3 ready",
        contribution: "request while second",
        criteria: "receive typed unavailable",
      });
      const durableState = async () => ({
        tasks: (
          await pool.query(
            `SELECT task_id::text, state, attempts, last_attempt_run::text
               FROM absurd.t_spool_conflict ORDER BY task_id`,
          )
        ).rows,
        runs: (
          await pool.query(
            `SELECT run_id::text, task_id::text, state, claimed_by,
                    claim_expires_at
               FROM absurd.r_spool_conflict ORDER BY run_id`,
          )
        ).rows,
        attempts: (
          await pool.query(
            `SELECT work_id, step_id, state FROM spool.attempts
              ORDER BY work_id, step_id, attempt_id`,
          )
        ).rows,
      });
      const before = await durableState();
      const bindingBefore = { ...bindingNfn3 };

      await assert.rejects(
        service.claimNext(bindingNfn3, identityNfn3, { leaseSeconds: 10 }),
        ClaimConflictError,
      );
      assert.deepEqual(await durableState(), before);

      const unavailable = await service.claimNext(bindingNfn3, identityNfn3, {
        expectedStepId: "nfn3-ready",
        leaseSeconds: 10,
      });
      assert.deepEqual(unavailable, {
        claimed: false,
        tracking: "unavailable",
        reason: "queue_head_mismatch",
        rollback: "confirmed",
        intended: {
          workId: workNfn3.workId,
          stepId: "nfn3-ready",
          taskId: nfn3Step.taskId,
        },
        head: {
          workId: workNfn1.workId,
          stepId: "nfn1-ready",
          taskId: nfn1Step.taskId,
        },
        nextAction:
          "Optional Spool tracking is unavailable because another admitted queue item is ahead. Continue otherwise authorized work untracked through normal coordination, or pause and ask if strict tracking is required. Do not retry, sweep, reorder, cancel, or claim the unrelated head.",
      });
      assert.deepEqual(await durableState(), before);
      assert.deepEqual(bindingNfn3, bindingBefore);

      const afterConflict = await service.resume(bindingNfn1, identityNfn1);
      assert.equal(afterConflict.steps[0]?.state, "ready");
      assert.equal(afterConflict.steps[0]?.latestAttempt, null);

      const claimNfn1 = await service.claimNext(bindingNfn1, identityNfn1, {
        expectedStepId: "nfn1-ready",
        leaseSeconds: 10,
      });
      assertClaimed(claimNfn1);
      await service.completeExecution(bindingNfn1, identityNfn1, {
        resultRef: "result:nfn1",
        summary: "free queue head",
      });
      const claimNfn3 = await service.claimNext(bindingNfn3, identityNfn3, {
        expectedStepId: "nfn3-ready",
        leaseSeconds: 10,
      });
      assertClaimed(claimNfn3);
      assert.equal(claimNfn3.stepId, "nfn3-ready");
    });
  },
);

test(
  "report withdraws only its unclaimed task and records attributed untracked progress",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_report", async (pool, service) => {
      const nfn1 = identity(
        "session-nfn1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      const nfn3 = identity(
        "session-nfn3",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      );
      const workNfn1 = await service.attach(
        {
          vault: "nfhotel_sb",
          taskId: "NFN-1",
          canonicalPath: "/vault/NFN-1.md",
          outcome: "remain unrelated and ready",
        },
        nfn1,
      );
      const workNfn3 = await service.attach(
        {
          vault: "nfhotel_sb",
          taskId: "NFN-3",
          canonicalPath: "/vault/NFN-3.md",
          outcome: "accept attributed reports",
        },
        nfn3,
      );
      const bindingNfn1 = binding(workNfn1);
      const bindingNfn3 = binding(workNfn3);
      const taskNfn1 = await service.materialize(bindingNfn1, {
        stepId: "nfn1-ready",
        title: "NFN-1 ready",
        contribution: "stay untouched",
        criteria: "task and run are unchanged",
      });
      await sleep(5);
      const taskNfn3 = await service.materialize(bindingNfn3, {
        stepId: "nfn3-report",
        title: "NFN-3 report",
        contribution: "show untracked work honestly",
        criteria: "report is attributed without an attempt",
      });
      const beforeNfn1 = await pool.query(
        `SELECT t.*, r.* FROM absurd.t_spool_report t
           JOIN absurd.r_spool_report r ON r.task_id = t.task_id
          WHERE t.task_id = $1`,
        [taskNfn1.taskId],
      );

      const progress = await service.report(bindingNfn3, nfn3, {
        stepId: "nfn3-report",
        disposition: "in_progress",
        summary: "Implementation is underway outside lease ownership",
        evidenceRef: "git:working-tree",
        nextAction: "Finish disposable verification",
      });
      assert.equal(progress.disposition, "in_progress");
      assert.equal(progress.execution, "untracked");
      assert.equal(progress.reporterPiSessionId, nfn3.piSessionId);
      assert.equal(progress.reporterRuntimeId, nfn3.runtimeId);
      assert.equal(progress.acceptance, "not_recorded");
      assert.deepEqual(
        (
          await pool.query(
            `SELECT t.*, r.* FROM absurd.t_spool_report t
               JOIN absurd.r_spool_report r ON r.task_id = t.task_id
              WHERE t.task_id = $1`,
            [taskNfn1.taskId],
          )
        ).rows,
        beforeNfn1.rows,
      );
      assert.deepEqual(
        (
          await pool.query(
            `SELECT state FROM absurd.t_spool_report WHERE task_id = $1`,
            [taskNfn3.taskId],
          )
        ).rows,
        [{ state: "cancelled" }],
      );
      assert.equal(
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM spool.attempts WHERE work_id = $1`,
              [workNfn3.workId],
            )
          ).rows[0]?.count,
        ),
        0,
      );

      const finished = await service.report(bindingNfn3, nfn3, {
        stepId: "nfn3-report",
        disposition: "finished",
        summary: "Implementation finished outside lease ownership",
        evidenceRef: "test:report-pass",
      });
      assert.equal(finished.disposition, "finished");
      const packet = await service.resume(bindingNfn3, nfn3);
      assert.equal(packet.steps[0]?.state, "reported_finished_untracked");
      assert.equal(packet.steps[0]?.trackedState, "ready");
      assert.equal(packet.steps[0]?.latestAttempt, null);
      assert.equal(packet.steps[0]?.report?.summary, finished.summary);
      assert.equal(packet.acceptance, "not_recorded");

      const dashboard = new SpoolDashboardReader(pool, "spool_report");
      const goals = await dashboard.loadGoals();
      const reportedGoal = goals.goals.find((goal) => goal.taskId === "NFN-3")!;
      assert.equal(reportedGoal.counts.ready, 0);
      assert.equal(reportedGoal.counts.reportedFinished, 1);
      const detail = await dashboard.loadGoal(reportedGoal, nfn3);
      assert.equal(detail.steps[0]?.stepState, "reported_finished_untracked");
      assert.equal(detail.steps[0]?.report?.summary, finished.summary);
    });
  },
);

test(
  "report cannot cancel a task won by a simultaneous real claim",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_report_race", async (pool, service) => {
      const reporter = identity(
        "session-reporter",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      );
      const work = await service.attach(
        {
          vault: "vault",
          taskId: "RACE-1",
          canonicalPath: "/vault/RACE-1.md",
          outcome: "reject cancellation after a real claim wins",
        },
        reporter,
      );
      const attached = binding(work);
      const materialized = await service.materialize(attached, {
        stepId: "race-step",
        title: "Race step",
        contribution: "prove pending-only withdrawal",
        criteria: "committed claim survives",
      });
      const claimClient = await pool.connect();
      try {
        await claimClient.query("BEGIN");
        const claimSdk = new Absurd({
          db: pool,
          queueName: "spool_report_race",
        }).bindToConnection(claimClient);
        const claimed = await claimSdk.claimTasks({
          batchSize: 1,
          claimTimeout: 30,
          workerId: "real-worker",
        });
        assert.equal(claimed[0]?.task_id, materialized.taskId);

        const reporting = service.report(attached, reporter, {
          stepId: "race-step",
          disposition: "in_progress",
          summary: "must lose to the committed real claim",
          evidenceRef: "race:test",
        });
        await sleep(50);
        await claimClient.query("COMMIT");
        await assert.rejects(reporting, SpoolDatabaseError);
      } finally {
        await claimClient.query("ROLLBACK").catch(() => undefined);
        claimClient.release();
      }

      assert.equal(
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM spool.step_reports WHERE work_id = $1`,
              [work.workId],
            )
          ).rows[0]?.count,
        ),
        0,
      );
      assert.deepEqual(
        (
          await pool.query(
            `SELECT state FROM absurd.t_spool_report_race WHERE task_id = $1`,
            [materialized.taskId],
          )
        ).rows,
        [{ state: "running" }],
      );
    });
  },
);

test(
  "unrelated ready head cannot soften a real owner of the intended step",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_owned_conflict", async (pool, service) => {
      const actualOwner = identity(
        "session-actual-owner",
        "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      );
      const requester = identity(
        "session-requester",
        "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      );
      const unrelatedOwner = identity(
        "session-unrelated",
        "33333333-cccc-4ccc-8ccc-cccccccccccc",
      );
      const intendedWork = await service.attach(
        {
          vault: "vault",
          taskId: "OWNED-1",
          canonicalPath: "/vault/OWNED-1.md",
          outcome: "keep real ownership visible",
        },
        actualOwner,
      );
      const intendedBinding = binding(intendedWork);
      await service.materialize(intendedBinding, {
        stepId: "owned-step",
        title: "Owned step",
        contribution: "remain owned",
        criteria: "mismatch stays hard",
      });
      const owned = await service.claimNext(intendedBinding, actualOwner, {
        expectedStepId: "owned-step",
        leaseSeconds: 30,
      });
      assertClaimed(owned);
      await assert.rejects(
        service.report(intendedBinding, requester, {
          stepId: "owned-step",
          disposition: "in_progress",
          summary: "must not overwrite leased ownership",
          evidenceRef: "none",
        }),
        LostOwnershipError,
      );

      const unrelatedWork = await service.attach(
        {
          vault: "vault",
          taskId: "READY-2",
          canonicalPath: "/vault/READY-2.md",
          outcome: "be the unrelated ready head",
        },
        unrelatedOwner,
      );
      const unrelatedBinding = binding(unrelatedWork);
      await service.materialize(unrelatedBinding, {
        stepId: "unrelated-ready",
        title: "Unrelated ready",
        contribution: "stay ready",
        criteria: "rollback preserves it",
      });
      const before = await pool.query(
        `SELECT task_id::text, state, attempts, last_attempt_run::text
           FROM absurd.t_spool_owned_conflict ORDER BY task_id`,
      );

      await assert.rejects(
        service.claimNext(intendedBinding, requester, {
          expectedStepId: "owned-step",
          leaseSeconds: 10,
        }),
        LostOwnershipError,
      );

      const after = await pool.query(
        `SELECT task_id::text, state, attempts, last_attempt_run::text
           FROM absurd.t_spool_owned_conflict ORDER BY task_id`,
      );
      assert.deepEqual(after.rows, before.rows);
      const intended = await service.resume(intendedBinding, requester);
      assert.equal(intended.steps[0]?.state, "running");
      assert.equal(intended.steps[0]?.latestAttempt?.leaseValid, true);
      assert.equal(
        intended.steps[0]?.latestAttempt?.piSessionId,
        actualOwner.piSessionId,
      );
      const unrelated = await service.resume(
        unrelatedBinding,
        unrelatedOwner,
      );
      assert.equal(unrelated.steps[0]?.state, "ready");
      assert.equal(unrelated.steps[0]?.latestAttempt, null);
    });
  },
);

test(
  "invalid queue-head admission remains a hard claim conflict",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_invalid_head", async (pool, service) => {
      const firstOwner = identity(
        "session-invalid-head",
        "44444444-dddd-4ddd-8ddd-dddddddddddd",
      );
      const intendedOwner = identity(
        "session-intended",
        "55555555-eeee-4eee-8eee-eeeeeeeeeeee",
      );
      const firstWork = await service.attach(
        {
          vault: "vault",
          taskId: "INVALID-1",
          canonicalPath: "/vault/INVALID-1.md",
          outcome: "simulate invalid local admission",
        },
        firstOwner,
      );
      const intendedWork = await service.attach(
        {
          vault: "vault",
          taskId: "INTENDED-2",
          canonicalPath: "/vault/INTENDED-2.md",
          outcome: "remain safely unclaimed",
        },
        intendedOwner,
      );
      const firstBinding = binding(firstWork);
      const intendedBinding = binding(intendedWork);
      await service.materialize(firstBinding, {
        stepId: "invalid-head",
        title: "Invalid head",
        contribution: "exercise admission check",
        criteria: "remain a hard error",
      });
      await sleep(5);
      await service.materialize(intendedBinding, {
        stepId: "intended-ready",
        title: "Intended ready",
        contribution: "stay ready",
        criteria: "no false fallback",
      });
      await pool.query(
        `UPDATE spool.steps SET absurd_task_id = NULL
          WHERE work_id = $1 AND step_id = 'invalid-head'`,
        [firstWork.workId],
      );

      await assert.rejects(
        service.claimNext(intendedBinding, intendedOwner, {
          expectedStepId: "intended-ready",
          leaseSeconds: 10,
        }),
        ClaimConflictError,
      );
      const intended = await service.resume(intendedBinding, intendedOwner);
      assert.equal(intended.steps[0]?.state, "ready");
      assert.equal(intended.steps[0]?.latestAttempt, null);
    });
  },
);

test(
  "read-only dashboard preserves ownership and exposes checkpoints, results, and omissions",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_dashboard", async (pool, service) => {
      const owner = identity(
        "dashboard-session",
        "dddddddd-4444-4444-8444-dddddddddddd",
      );
      const work = await service.attach(
        {
          vault: "zeebs_sb",
          taskId: "DASH-1",
          canonicalPath: "/vault/tasks/DASH-1.md",
          outcome: "browse raw durable state without mutation",
        },
        owner,
      );
      const attached = binding(work);
      await service.materialize(attached, {
        stepId: "dashboard-active",
        title: "Dashboard active step",
        contribution: "prove ownership is not disturbed",
        criteria: "checkpoint and completion references remain visible",
      });
      assert.ok(
        await service.claimNext(attached, owner, {
          expectedStepId: "dashboard-active",
          leaseSeconds: 30,
        }),
      );
      await service.checkpoint(attached, owner, {
        checkpointName: "dashboard-evidence",
        evidenceRef: "artifact:dashboard-v1",
        nextAction: "inspect the read-only snapshot",
      });

      const reader = new SpoolDashboardReader(pool, "spool_dashboard");
      const goals = await reader.loadGoals();
      assert.equal(goals.readOnly, true);
      assert.equal(goals.totalGoals, 1);
      assert.deepEqual(goals.goals[0]?.counts, {
        executionCompleted: 0,
        running: 1,
        ready: 0,
        reportedInProgress: 0,
        reportedFinished: 0,
        participatingSessions: 1,
      });
      const active = await reader.loadGoal(goals.goals[0]!, owner);
      assert.equal(active.readOnly, true);
      assert.equal(active.steps[0]?.latestAttempt?.isCurrentRuntimeOwner, true);
      assert.deepEqual(active.steps[0]?.checkpoint, {
        name: "dashboard-evidence",
        evidenceRef: "artifact:dashboard-v1",
        recordedAt: active.steps[0]?.checkpoint?.recordedAt ?? null,
      });
      assert.equal(
        active.steps[0]?.latestAttempt?.nextAction,
        "inspect the read-only snapshot",
      );
      const beforeHeartbeatActivity = active.steps[0]!.lastActivityAt;
      await service.heartbeat(attached, owner, 30);
      const afterHeartbeat = await reader.loadGoal(
        goals.goals[0]!,
        owner,
        "recent",
      );
      assert.ok(
        afterHeartbeat.steps[0]!.lastActivityAt.getTime() >=
          beforeHeartbeatActivity.getTime(),
      );

      await service.completeExecution(attached, owner, {
        resultRef: "git:dashboard",
        summary: "dashboard source step completed",
      });
      const completed = await reader.loadGoal(goals.goals[0]!, owner);
      assert.deepEqual(completed.steps[0]?.completion, {
        summary: "dashboard source step completed",
        resultRef: "git:dashboard",
      });
      assert.equal(
        completed.steps[0]?.latestAttempt?.nextAction,
        "Await separate review/acceptance if required",
      );

      for (let index = 0; index < 50; index += 1) {
        await service.materialize(attached, {
          stepId: `dashboard-ready-${index.toString().padStart(2, "0")}`,
          title: `Dashboard ready ${index}`,
          contribution: "exercise bounded display windows",
          criteria: "remain ready",
        });
      }
      const before = await dashboardFingerprint(pool);
      const refreshedGoals = await reader.loadGoals();
      assert.deepEqual(refreshedGoals.goals[0]?.counts, {
        executionCompleted: 1,
        running: 0,
        ready: 50,
        reportedInProgress: 0,
        reportedFinished: 0,
        participatingSessions: 1,
      });
      const bounded = await reader.loadGoal(refreshedGoals.goals[0]!, owner);
      assert.equal(bounded.totalSteps, 51);
      assert.equal(bounded.steps.length, 50);
      assert.equal(bounded.omittedSteps, 1);
      assert.equal(bounded.steps.every((step) => step.stepState === "ready"), true);
      assert.deepEqual(await dashboardFingerprint(pool), before);
      await reader.close();
    });
  },
);

test(
  "dashboard sorting happens before bounded goal and step windows",
  { timeout: 120_000 },
  async () => {
    await withHarness("spool_sort", async (pool) => {
      await pool.query(
        `INSERT INTO spool.works (
           work_id, queue_name, vault, pkm_task_id, canonical_path, outcome,
           created_at, updated_at
         )
         SELECT format('work-sort-%s', value), 'spool_sort', 'vault',
                format('SORT-%s', lpad(value::text, 2, '0')),
                format('/tmp/SORT-%s.md', lpad(value::text, 2, '0')),
                format('purpose %s', value),
                timestamptz '2026-07-01T00:00:00Z' + value * interval '1 day',
                timestamptz '2026-07-01T00:00:00Z' + value * interval '1 day'
           FROM generate_series(0, 50) value`,
      );
      await pool.query(
        `INSERT INTO spool.steps (
           work_id, step_id, title, contribution, completion_criteria, state,
           created_at, updated_at
         )
         SELECT 'work-sort-25',
                format('step-%s', lpad(value::text, 2, '0')),
                format('Step %s', value), 'sort contribution', 'sort criteria',
                CASE WHEN value = 0 THEN 'running' ELSE 'ready' END,
                timestamptz '2026-07-26T00:00:00Z' + value * interval '1 minute',
                timestamptz '2026-07-26T00:00:00Z' + value * interval '1 minute'
           FROM generate_series(0, 50) value`,
      );
      await pool.query(
        `INSERT INTO spool.attempts (
           attempt_id, work_id, step_id, absurd_task_id, absurd_run_id,
           absurd_attempt, pi_session_id, pi_session_name, runtime_id,
           state, lease_expires_at, claimed_at, updated_at
         ) VALUES (
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'work-sort-25', 'step-00',
           'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
           'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1,
           'sort-session', 'sort owner',
           'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
           'active', '2099-01-01T00:00:00Z',
           '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'
         )`,
      );

      const reader = new SpoolDashboardReader(pool, "spool_sort");
      const attention = await reader.loadGoals("attention");
      assert.equal(attention.goals[0]?.taskId, "SORT-25");
      assert.equal(attention.omittedGoals, 1);
      const recent = await reader.loadGoals("recent");
      assert.equal(recent.goals[0]?.taskId, "SORT-50");
      assert.equal(recent.goals.some((goal) => goal.taskId === "SORT-00"), false);
      const oldest = await reader.loadGoals("oldest");
      assert.equal(oldest.goals[0]?.taskId, "SORT-00");
      assert.equal(oldest.goals.some((goal) => goal.taskId === "SORT-50"), false);

      const viewer = identity(
        "sort-viewer",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      );
      const goal = attention.goals[0]!;
      const attentionSteps = await reader.loadGoal(goal, viewer, "attention");
      assert.equal(attentionSteps.steps[0]?.stepId, "step-00");
      assert.equal(attentionSteps.omittedSteps, 1);
      const recentSteps = await reader.loadGoal(goal, viewer, "recent");
      assert.equal(recentSteps.steps[0]?.stepId, "step-50");
      assert.equal(
        recentSteps.steps.some((step) => step.stepId === "step-00"),
        false,
      );
      const oldestSteps = await reader.loadGoal(goal, viewer, "oldest");
      assert.equal(oldestSteps.steps[0]?.stepId, "step-00");
      assert.equal(
        oldestSteps.steps.some((step) => step.stepId === "step-50"),
        false,
      );
    });
  },
);

async function dashboardFingerprint(pool: Pool): Promise<Record<string, string>> {
  const result = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*)::text FROM spool.works) AS works,
       (SELECT count(*)::text FROM spool.steps) AS steps,
       (SELECT count(*)::text FROM spool.attempts) AS attempts,
       (SELECT count(*)::text FROM spool.attempts WHERE state = 'active') AS active`,
  );
  return result.rows[0]!;
}

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
        assertClaimed(claimed);
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
      assertClaimed(claimA);
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
      await assert.rejects(
        service.report(attached, ownerA, {
          stepId: "expiry-step",
          disposition: "in_progress",
          summary: "must not hide expired ownership",
          evidenceRef: "none",
        }),
        LostOwnershipError,
      );
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
      assertClaimed(claimB);
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
