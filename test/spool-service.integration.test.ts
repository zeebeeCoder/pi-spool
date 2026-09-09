import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import type { SessionBinding } from "../src/binding.ts";
import { SpoolDashboardReader } from "../src/dashboard-data.ts";
import {
  MAX_RESUME_PACKET_BYTES,
  MAX_RESUME_STEPS,
  SpoolService,
  type RuntimeIdentity,
} from "../src/spool-service.ts";

const spoolSql = readFileSync(new URL("../sql/spool.sql", import.meta.url), "utf8");
const spoolV1Sql = readFileSync(new URL("./fixtures/spool-v1.sql", import.meta.url), "utf8");
const migration002 = readFileSync(
  new URL("../sql/migrations/002-thin-events.sql", import.meta.url),
  "utf8",
);

function identity(session: string, name: string | null = `name-${session}`): RuntimeIdentity {
  return {
    piSessionId: session,
    piSessionName: name,
    piSessionFile: `/sessions/${session}.jsonl`,
    runtimeId: "11111111-1111-4111-8111-111111111111",
  };
}

function bindingOf(work: { workId: string; vault: string; taskId: string; canonicalPath: string }): SessionBinding {
  return {
    version: 1,
    workId: work.workId,
    vault: work.vault,
    taskId: work.taskId,
    canonicalPath: work.canonicalPath,
  };
}

async function withDatabase(
  schema: string,
  run: (pool: Pool) => Promise<void>,
): Promise<void> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  try {
    await pool.query(schema);
    await run(pool);
  } finally {
    await pool.end().catch(() => undefined);
    await container.stop();
  }
}

test("attach, note, done, and resume round-trip through the event log", async () => {
  await withDatabase(spoolSql, async (pool) => {
    const service = new SpoolService(pool);
    const a = identity("session-a");
    const work = await service.attach({
      vault: "nfhotel_sb",
      taskId: "NFN-1",
      canonicalPath: "/vaults/nfhotel_sb/tasks/NFN-1.md",
      outcome: "Define the pricing domain",
    });
    const binding = bindingOf(work);

    const empty = await service.resume(binding, a);
    assert.equal(empty.current, null);
    assert.equal(empty.nextAction, "Record a note for the first step");
    assert.deepEqual(empty.steps, []);

    const first = await service.note(binding, a, {
      stepId: "as-is",
      title: "Synthesize the as-is model",
      summary: "Started collecting evidence",
      nextAction: "Read the schema dump",
    });
    assert.equal(first.created, true);
    assert.equal(first.warning, null);

    const second = await service.note(binding, a, {
      stepId: "as-is",
      summary: "Schema mapped",
      evidenceRef: "local:as-is.md",
      nextAction: "Write the synthesis",
    });
    assert.equal(second.created, false);
    assert.equal(second.warning, null);

    const resumed = await service.resume(binding, a);
    assert.equal(resumed.current, "as-is");
    assert.equal(resumed.nextAction, "Write the synthesis");
    assert.equal(resumed.steps.length, 1);
    assert.equal(resumed.steps[0]!.title, "Synthesize the as-is model");
    assert.equal(resumed.steps[0]!.state, "open");
    assert.equal(resumed.steps[0]!.last.summary, "Schema mapped");
    assert.equal(resumed.steps[0]!.last.mine, true);

    const finished = await service.done(binding, a, {
      stepId: "as-is",
      summary: "Synthesis written",
      evidenceRef: "git:abc123",
    });
    assert.equal(finished.recorded, "done");
    const afterDone = await service.resume(binding, a);
    assert.equal(afterDone.steps[0]!.state, "done");
    assert.equal(afterDone.steps[0]!.reviewed, false);
    assert.equal(afterDone.current, null);
    assert.equal(afterDone.nextAction, "All recorded steps are done");

    // Re-attaching with a new outcome updates the goal in place.
    const again = await service.attach({
      vault: "nfhotel_sb",
      taskId: "NFN-1",
      canonicalPath: "/vaults/nfhotel_sb/tasks/NFN-1.md",
      outcome: "Refined outcome",
    });
    assert.equal(again.workId, work.workId);
    assert.equal(again.outcome, "Refined outcome");
    const keep = await service.attach({
      vault: "nfhotel_sb",
      taskId: "NFN-1",
      canonicalPath: "/vaults/nfhotel_sb/tasks/NFN-1.md",
    });
    assert.equal(keep.outcome, "Refined outcome");
  });
});

test("two sessions on one step warn each other but are never blocked", async () => {
  await withDatabase(spoolSql, async (pool) => {
    const service = new SpoolService(pool);
    const origin = identity("origin", "coordinator");
    const worker = identity("worker", "pod-nfn1");
    const work = await service.attach({
      vault: "v",
      taskId: "T-1",
      canonicalPath: "/vaults/v/tasks/T-1.md",
    });
    const binding = bindingOf(work);
    await service.note(binding, origin, {
      stepId: "target-domain",
      summary: "Drafting the domain contract",
      nextAction: "Resume NFN-4",
    });

    const peer = await service.note(binding, worker, {
      stepId: "target-domain",
      summary: "Worker picking up the scenario pack",
    });
    assert.equal(peer.created, false);
    assert.match(peer.warning!, /coordinator noted this step \d+m ago: Drafting the domain contract/);

    const back = await service.note(binding, origin, {
      stepId: "target-domain",
      summary: "Coordinator continues",
    });
    assert.match(back.warning!, /pod-nfn1 noted this step/);

    const finish = await service.done(binding, worker, {
      stepId: "target-domain",
      summary: "Scenario pack drafted",
    });
    assert.match(finish.warning!, /coordinator noted this step/);

    const reopen = await service.note(binding, origin, {
      stepId: "target-domain",
      summary: "One more revision",
    });
    assert.match(reopen.warning!, /marked done .* by pod-nfn1; this note reopens it/);
    const twice = await service.done(binding, origin, {
      stepId: "target-domain",
      summary: "Really done",
      reviewed: true,
    });
    assert.equal(twice.warning, null);
    const again = await service.done(binding, worker, {
      stepId: "target-domain",
      summary: "Also done",
    });
    assert.match(again.warning!, /already marked done .* by coordinator; recorded again/);

    const view = await service.resume(binding, worker);
    assert.equal(view.steps[0]!.state, "done");
    assert.equal(view.current, null);

    // A different goal on the same database is entirely independent.
    const other = await service.attach({
      vault: "v",
      taskId: "T-2",
      canonicalPath: "/vaults/v/tasks/T-2.md",
    });
    const fresh = await service.note(bindingOf(other), worker, {
      stepId: "anything",
      summary: "No head-of-queue to block this",
    });
    assert.equal(fresh.created, true);
    assert.equal(fresh.warning, null);
  });
});

test("an old peer note outside the window and my own notes do not warn", async () => {
  await withDatabase(spoolSql, async (pool) => {
    const service = new SpoolService(pool);
    const a = identity("a");
    const b = identity("b");
    const work = await service.attach({ vault: "v", taskId: "T", canonicalPath: "/vaults/v/T.md" });
    const binding = bindingOf(work);
    await service.note(binding, a, { stepId: "s", summary: "old" });
    await pool.query(
      "UPDATE spool.events SET recorded_at = now() - interval '3 hours' WHERE step_id = 's'",
    );
    const later = await service.note(binding, b, { stepId: "s", summary: "much later" });
    assert.equal(later.warning, null);
    const mine = await service.note(binding, b, { stepId: "s", summary: "mine again" });
    assert.equal(mine.warning, null);
  });
});

test("resume is bounded: open steps first, then done, with omissions counted", async () => {
  await withDatabase(spoolSql, async (pool) => {
    const service = new SpoolService(pool);
    const a = identity("a");
    const work = await service.attach({ vault: "v", taskId: "T", canonicalPath: "/vaults/v/T.md" });
    const binding = bindingOf(work);
    for (let index = 0; index < MAX_RESUME_STEPS + 5; index += 1) {
      await service.note(binding, a, {
        stepId: `step-${index}`,
        summary: "x".repeat(500),
        nextAction: "y".repeat(500),
        evidenceRef: "z".repeat(1_000),
      });
      if (index % 2 === 0) {
        await service.done(binding, a, { stepId: `step-${index}`, summary: "done" });
      }
    }
    const packet = await service.resume(binding, a);
    assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= MAX_RESUME_PACKET_BYTES);
    assert.ok(packet.steps.length <= MAX_RESUME_STEPS);
    assert.equal(packet.steps.length + packet.omittedSteps, MAX_RESUME_STEPS + 5);
    const states = packet.steps.map((step) => step.state);
    const firstDone = states.indexOf("done");
    assert.ok(firstDone === -1 || !states.slice(firstDone).includes("open"));
    assert.equal(packet.current, packet.steps.find((s) => s.state === "open")?.stepId);
    for (const step of packet.steps) {
      assert.ok(step.last.summary.length <= 240);
    }
  });
});

test("overview lists every goal with its current step, and peek reads one without a binding", async () => {
  await withDatabase(spoolSql, async (pool) => {
    const service = new SpoolService(pool);
    const a = identity("a", "alpha");
    const b = identity("b", "beta");
    const one = await service.attach({ vault: "nfhotel_sb", taskId: "NFN-1", canonicalPath: "/vaults/nfhotel_sb/NFN-1.md", outcome: "Pricing" });
    const two = await service.attach({ vault: "zeebs_sb", taskId: "ALD-1", canonicalPath: "/vaults/zeebs_sb/ALD-1.md" });
    await service.attach({ vault: "other_sb", taskId: "ALD-1", canonicalPath: "/vaults/other_sb/ALD-1.md" });
    await service.note(bindingOf(one), a, { stepId: "as-is", title: "As-is", summary: "done soon" });
    await service.done(bindingOf(one), a, { stepId: "as-is", summary: "finished" });
    await service.note(bindingOf(one), b, { stepId: "target", title: "Target domain", summary: "drafting", nextAction: "Resume NFN-4" });
    await service.note(bindingOf(two), a, { stepId: "thin-v2", summary: "refactor" });

    const overview = await service.overview(b);
    assert.equal(overview.scope, "all");
    assert.equal(overview.omittedGoals, 0);
    assert.deepEqual(
      overview.goals.map((g) => [g.vault, g.taskId, g.openSteps, g.doneSteps, g.sessions, g.current?.stepId ?? null, g.current?.mine ?? null]),
      [
        ["zeebs_sb", "ALD-1", 1, 0, 1, "thin-v2", false],
        ["nfhotel_sb", "NFN-1", 1, 1, 2, "target", true],
        ["other_sb", "ALD-1", 0, 0, 0, null, null],
      ],
    );
    assert.equal(overview.goals[1]!.current?.nextAction, "Resume NFN-4");
    assert.equal(overview.goals[1]!.current?.session, "beta");
    assert.ok(Buffer.byteLength(JSON.stringify(overview), "utf8") <= MAX_RESUME_PACKET_BYTES);

    const peeked = await service.peek({ taskId: "NFN-1" }, a);
    assert.equal(peeked.goal.workId, one.workId);
    assert.equal(peeked.current, "target");
    await assert.rejects(service.peek({ taskId: "ALD-1" }, a), /exists in .*; pass vault/);
    assert.equal((await service.peek({ taskId: "ALD-1", vault: "zeebs_sb" }, a)).goal.workId, two.workId);
    await assert.rejects(service.peek({ taskId: "NOPE-1" }, a), /no recorded goal/);
  });
});

test("dashboard reader summarizes goals, steps, and step history read-only", async () => {
  await withDatabase(spoolSql, async (pool) => {
    const service = new SpoolService(pool);
    const reader = new SpoolDashboardReader(pool);
    const a = identity("a", "alpha");
    const b = identity("b", "beta");
    const work = await service.attach({
      vault: "v",
      taskId: "T-1",
      canonicalPath: "/vaults/v/tasks/T-1.md",
      outcome: "Ship it",
    });
    const binding = bindingOf(work);
    await service.note(binding, a, { stepId: "one", title: "One", summary: "start" });
    await service.note(binding, b, { stepId: "one", summary: "help" });
    await service.done(binding, a, { stepId: "one", summary: "end", reviewed: true });
    await service.note(binding, a, { stepId: "two", title: "Two", summary: "open" });

    const goals = await reader.loadGoals();
    assert.equal(goals.totalGoals, 1);
    assert.equal(goals.goals[0]!.openSteps, 1);
    assert.equal(goals.goals[0]!.doneSteps, 1);
    assert.equal(goals.goals[0]!.sessions, 2);

    const detail = await reader.loadGoal(goals.goals[0]!, a);
    assert.deepEqual(
      detail.steps.map((step) => [step.stepId, step.state, step.reviewed, step.eventCount]),
      [
        ["two", "open", false, 1],
        ["one", "done", true, 3],
      ],
    );
    const history = await reader.loadStep(goals.goals[0]!, detail.steps[1]!, a);
    assert.deepEqual(
      history.events.map((event) => [event.kind, event.sessionName, event.mine]),
      [
        ["done", "alpha", true],
        ["note", "beta", false],
        ["note", "alpha", true],
      ]);
    const before = await pool.query("SELECT count(*)::int AS n FROM spool.events");
    await reader.loadGoals();
    const after = await pool.query("SELECT count(*)::int AS n FROM spool.events");
    assert.equal(before.rows[0].n, after.rows[0].n);
  });
});

test("migration 002 converts a v1 database into the event log", async () => {
  const v1 = `
    create schema absurd;
    create function absurd.current_time() returns timestamptz language sql as 'select now()';
    ${spoolV1Sql}
  `;
  await withDatabase(v1, async (pool) => {
    await pool.query(
      `INSERT INTO spool.works (work_id, queue_name, vault, pkm_task_id, canonical_path, outcome)
       VALUES ('work_1', 'q', 'v', 'T-1', '/vaults/v/T-1.md', 'Old outcome')`,
    );
    await pool.query(
      `INSERT INTO spool.steps (work_id, step_id, title, contribution, completion_criteria, state)
       VALUES ('work_1', 'done-step', 'Done step', 'It contributes', 'When done', 'execution_completed'),
              ('work_1', 'ready-step', 'Ready step', 'Later', 'Whenever', 'ready')`,
    );
    await pool.query(
      `INSERT INTO spool.attempts
         (attempt_id, work_id, step_id, absurd_task_id, absurd_run_id, absurd_attempt,
          pi_session_id, pi_session_name, runtime_id, state, lease_expires_at,
          last_transition, last_summary, last_evidence_ref, next_action)
       VALUES (gen_random_uuid(), 'work_1', 'done-step', gen_random_uuid(), gen_random_uuid(), 1,
               'sess-1', 'pod', gen_random_uuid(), 'execution_completed', now(),
               'execution_completed', 'Finished it', 'git:abc', 'Await review')`,
    );
    await pool.query(
      `INSERT INTO spool.step_reports
         (work_id, step_id, disposition, summary, evidence_ref, reporter_pi_session_id, reporter_runtime_id)
       VALUES ('work_1', 'ready-step', 'in_progress', 'Untracked progress', 'local:x', 'sess-2', gen_random_uuid())`,
    );
    await pool.query(migration002);
    // Idempotent-ish for the schema parts; backfill runs once in practice.
    const service = new SpoolService(pool);
    const packet = await service.resume(
      { version: 1, workId: "work_1", vault: "v", taskId: "T-1", canonicalPath: "/vaults/v/T-1.md" },
      identity("sess-2", null),
    );
    assert.deepEqual(
      packet.steps.map((step) => [step.stepId, step.state, step.last.summary]),
      [
        ["ready-step", "open", "Untracked progress"],
        ["done-step", "done", "Finished it"],
      ],
    );
    assert.equal(packet.current, "ready-step");
    const kinds = await pool.query(
      "SELECT step_id, kind, count(*)::int AS n FROM spool.events GROUP BY 1, 2 ORDER BY 1, 2",
    );
    assert.deepEqual(kinds.rows, [
      { step_id: "done-step", kind: "done", n: 1 },
      { step_id: "done-step", kind: "note", n: 2 },
      { step_id: "ready-step", kind: "note", n: 2 },
    ]);
    // New writes work on the migrated schema.
    const fresh = await service.note(
      { version: 1, workId: "work_1", vault: "v", taskId: "T-1", canonicalPath: "/vaults/v/T-1.md" },
      identity("sess-3"),
      { stepId: "brand-new", summary: "post-migration" },
    );
    assert.equal(fresh.created, true);
    const attach = await service.attach({ vault: "v", taskId: "T-1", canonicalPath: "/vaults/v/T-1.md" });
    assert.equal(attach.workId, "work_1");
  });
});
