# pi-spool

Experimental Pi extension: a thin work log for PKM goals. An agent working on a
task file calls one tool, `spool`, with three actions, so that a later session
can pick the work up where it stopped. A read-only `/spool` browser shows the
log to humans.

```text
resume (attach the task file)  →  note … note  →  done
```

Spool never blocks or authorizes work. The PKM task file is the goal, Git is
the implementation evidence, the Pi transcript is the conversation, and Spool
is the short durable trail between sessions.

## Why v2 replaced the Absurd-backed v1

v1 layered a lease and claim protocol over Absurd, a Postgres job queue. One
shared FIFO queue meant any goal's unclaimed step blocked every other goal, a
mismatched claim rolled back the expiry sweep so stale leases never cleared,
and the nine-action protocol consumed agent attention that belonged on the
goal. v2 keeps the useful part, a durable per-step trail with session
attribution, and drops queues, leases, claims, heartbeats, and the dependency.
See `CHANGELOG.md`.

## Install and verify

Requirements: Node 22.18+ and a Docker daemon for tests.

```bash
npm ci
npm run typecheck
npm test
```

Tests start disposable `postgres:16-alpine` Testcontainers, including one that
applies the v1 to v2 migration against a v1 schema.

```bash
pi install /absolute/path/to/pi-spool   # local path package; edits are live
pi remove /absolute/path/to/pi-spool
```

## Configuration

`~/.pi/agent/spool.json`:

```json
{ "databaseUrl": "postgresql://spool:spool@127.0.0.1:55432/spool" }
```

`SPOOL_DATABASE_URL` overrides the file. A leftover v1 `queueName` key is
ignored. The file is read lazily on the first `spool` call; loading Pi opens no
connection. Protect the file (`chmod 600`) because the URL may hold credentials.

## Local database

```bash
docker compose up -d --wait
```

Starts Postgres 16 on `127.0.0.1:55432` with user, password, and database
`spool`. A fresh volume gets `sql/spool.sql`. An existing v1 volume keeps its
data; apply the migration once, after a backup:

```bash
docker compose exec -T postgres psql -U spool -d spool -1 -f - \
  < sql/migrations/002-thin-events.sql
```

The migration is additive. It creates `spool.events`, relaxes v1 columns, and
backfills events from v1 attempts, reports, and Absurd checkpoints. It leaves
the v1 tables and the `absurd` schema in place so nothing is lost.

## Tool

One tool, `spool`, three actions:

| action | required | optional | effect |
|---|---|---|---|
| `resume` | | `canonicalPath`, `vault`, `outcome`, `taskId`, `scope` | No attached goal, or `scope: "all"`: overview of every goal with counts, current step, next action, and task path. `canonicalPath`: attach the PKM task (ID from frontmatter `id`, vault from a `vaults/<name>/` path segment) and return its view. `taskId`: read another goal without attaching. |
| `note` | `stepId`, `summary` | `title`, `evidenceRef`, `nextAction` | Appends progress. An unknown `stepId` creates the step. |
| `done` | `stepId`, `summary` | `evidenceRef`, `reviewed` | Marks the step finished. `reviewed` defaults to false. |

Results are small JSON. The overview returns at most 20 goals. A goal view returns at most 12 steps, open ones first,
text fields cut at 240 characters, and the whole packet under 6 KB with an
`omittedSteps` count. `note` and `done` may carry a `warning` when another
session touched the same step in the last hour or the step was already done.
Warnings are advisory. Nothing in Spool refuses a write.

Identity comes from Pi context: session ID, session name, session file. The
binding to a goal is stored as a custom session entry and restored on session
start without opening the database.

## Using it outside Pi (Claude Code, shell, cron)

`bin/spool.ts` wraps the same service with the same three actions and writes
to the same database, so any agent that can run a shell command can read and
append to the log. Identity comes from `SPOOL_SESSION_ID` and
`SPOOL_SESSION_NAME`; without them it is `<user>@<host>:<pid>`.

```bash
npm run spool -- resume                                   # overview of all goals
npm run spool -- resume --task NFN-4                      # peek at one goal
npm run spool -- resume --path ~/vaults/zeebs_sb/tasks/2026/09/ALD-1.md
npm run spool -- note --task ALD-1 --step ald1.thin-v2 \
  --summary "Ready for review" --evidence "git:abc123" --next "Reviewer runs npm test"
npm run spool -- done --task ALD-1 --step ald1.thin-v2 --summary "Accepted" --reviewed
```

Output is JSON. For Claude Code, set `SPOOL_SESSION_ID` to its session ID and
add a line to the project's `CLAUDE.md` pointing at these commands; no MCP
server is needed for a three-verb log. An MCP wrapper would be about forty
lines over `SpoolService` if native tool calls are wanted later.

## Unattended pods on Absurd (phase 1)

Interactive sessions are traced by the three verbs. Unattended work runs as
Absurd tasks, where Absurd supplies what a laptop otherwise lacks: a lease,
retry after the process dies, per-message checkpoints, and an awaitable
result. The pod's own Pi session file remains the message log; on retry the
pod reopens it and continues.

```bash
npm run pod -- serve                                    # worker on queue spool_pods
npm run pod -- spawn --task ALD-1 --step ald1.smoke \
  --assignment "Read README.md and summarise it." --cwd $PWD --tools read --wait
npm run pod -- status <taskID>
```

Each pod writes a Spool `note` when it starts, a note on every retry, and
`done` when it finishes, so it appears beside human sessions in `/spool`.
`POD_CLAIM_TIMEOUT` sets the lease in seconds (default 300); a heartbeat runs
after every message. A fresh compose volume installs the vendored Absurd
schema (`sql/vendor`, checksum-tested) and the `spool_pods` queue. On an
existing volume run `select absurd.create_queue('spool_pods','unpartitioned')`.

Phase 1 evidence on 2026-09-09: a pod killed with SIGKILL at message 17
resumed on attempt 2 from the same session file with no repeated tool call.
Phases 2 (coordinator fan-out with awaited results) and 3 (review gate via
`awaitEvent`) are next.

## Storage

Three tables in schema `spool`: `works` (one per vault and task ID), `steps`
(ID and title), and `events` (append-only notes and done markers with session
attribution). State is derived from the latest event per step. Every write is
one short transaction. Connection, statement, and query timeouts are bounded;
a lost commit acknowledgement is reported as uncertain rather than retried.

## `/spool` browser

Interactive Pi only. Goals sorted by last activity, then steps with open ones
first, then a step's full history newest first. `p` opens the PKM task
reference, `r` refreshes, `Esc` goes back. Reads use a repeatable-read,
read-only transaction and never write.

## Limits

- No pagination beyond the 12-step resume window and 100-event history view.
- No enforcement of exclusive ownership; peers are warned, not stopped.
- No acceptance workflow; `reviewed` is a flag the caller sets.
- The local path install tracks the working tree, not a tagged artifact.
