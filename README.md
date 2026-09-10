# pi-spool

A [Pi](https://pi.dev) extension that keeps a work log for a goal in Postgres,
so a later session, or another agent, can see what was done and continue.
Unattended work can run as [Absurd](https://github.com/earendil-works/absurd)
tasks on the same database and survive the process dying.

The goal is a task file with an `id` in its frontmatter. Steps are named by
the agent as it goes. Every note carries the session that wrote it.

## Why

This is not another sub-agent framework or workflow engine. How agents
collaborate is your choice: sub-agents, a flat fleet of peers, or sessions
talking over an intercom. Whatever the shape, at some point you want a ledger
that attributes every session's work to the goal or spec it served. Spool is
that ledger. Composition stays yours.

![resume, note, done](docs/figures/spool-1-three-verbs.png)

## The tool

| action | what it does | fields |
|---|---|---|
| `resume` | With no attached goal: every goal, its current step, next action. With `canonicalPath`: attach a task file and return its steps. With `taskId`: read another goal without attaching. | `canonicalPath` `vault` `outcome` `taskId` `scope` |
| `note` | Record progress on a step and what to do next. A new `stepId` creates the step. | `stepId` `summary` `title` `evidenceRef` `nextAction` |
| `done` | Mark a step finished. `reviewed` is false until a human sets it. | `stepId` `summary` `evidenceRef` `reviewed` |

Output is JSON, capped at 20 goals, 12 steps, 6 KB. If another session wrote
to the same step in the last hour the result carries a `warning`; the write
still lands. Spool never refuses a write and never blocks work.

`/spool` inside Pi opens a read-only browser over the same data. Outside Pi
the CLI does the same three things:

```bash
npm run spool -- resume
npm run spool -- resume --task NFN-4
npm run spool -- note --task ALD-1 --step s1 --summary "Drafted" --next "Review"
npm run spool -- done --task ALD-1 --step s1 --summary "Accepted" --reviewed
```

Identity for the CLI comes from `SPOOL_SESSION_ID` and `SPOOL_SESSION_NAME`.

## How it fits together

![Goal, sessions, extension, service, storage](docs/figures/spool-2-layers.png)

Interactive sessions write notes through the tool or the CLI. Unattended pods
write the same notes at their boundaries and run on Absurd underneath.

## Pods on Absurd

A pod is a headless Pi session run as an Absurd task. The pod's session file
is the message log. Absurd adds a lease, a checkpoint per message, a retry
when the process dies, and a result the caller can await.

```bash
npm run pod -- serve --concurrency 3
npm run pod -- spawn  --task ALD-1 --step s1 --assignment "…" --cwd $PWD --tools read --wait
npm run pod -- fanout --task ALD-1 --step s2 --plan pods.json --worktree-base ../.worktrees --wait
```

`fanout` runs a coordinator as a task on its own queue: one git worktree per
pod, one spawn per pod with an idempotency key, one checkpointed wait per
result. `pods.json` is an array of `{stepId, title, assignment, tools?, cwd?}`.

This is a real run with the worker killed at twenty seconds. All four tasks
resumed; thirty-six file reads, none repeated.

![Fan-out, kill, resume](docs/figures/spool-3-fanout-kill-resume.png)

## Absurd, briefly

Queue, task, run, checkpoint. Checkpoints belong to the task, so a retry
inherits them.

![Queue, task, runs, checkpoints](docs/figures/absurd-1-hierarchy.png)

A run holds a lease. If the heartbeat stops, the next claim sweeps it and a
new run continues from the same checkpoints.

![Run state machine](docs/figures/absurd-2-run-lifecycle.png)

Every model turn is a checkpoint. After a crash the next attempt replays the
stored turns and pays only for the ones that never happened.

![Agent loop replay after a crash](docs/figures/absurd-3-agent-loop.png)

Parents spawn and await children; a task can sleep on an event until a human
emits it. Parents and children use separate queues.

![Parent, child, human, Postgres](docs/figures/absurd-4-coordination.png)

Background: Armin Ronacher's
[announcement](https://lucumr.pocoo.org/2025/11/3/absurd-workflows/) and
[production notes](https://lucumr.pocoo.org/2026/4/4/absurd-in-production/).

## Setup

Node 22.18+ and Docker.

```bash
docker compose up -d --wait      # Postgres 16 on 127.0.0.1:55432; fresh volume gets both schemas and the queues
npm ci && npm test               # Testcontainers; no host database touched
pi install /absolute/path/to/pi-spool
```

`~/.pi/agent/spool.json`, or `SPOOL_DATABASE_URL`:

```json
{ "databaseUrl": "postgresql://spool:spool@127.0.0.1:55432/spool" }
```

Nothing connects until the first `spool` call. Upgrading a v1 database:
apply `sql/migrations/002-thin-events.sql` once after a backup, then create
the `spool_pods` and `spool_fanout` queues with `absurd.create_queue`.

## Limits

- Peers are warned, not locked out. Two sessions can note the same step.
- `reviewed` is a flag, not a workflow.
- The review gate for pods (`awaitEvent`) is not built yet.
- Experimental. A local-path install tracks the working tree.
