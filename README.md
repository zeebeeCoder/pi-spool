# pi-spool

Experimental Pi durable-work package for ALD-1. Release `0.1.0-experimental.1`
provides one agent-facing `spool` tool and a narrow single-agent loop:

```text
attach canonical PKM goal
  → materialize one consequential step
  → claim next queue item
  → checkpoint / status / resume
  → execution complete
```

This is not the full ALD-1 design: there is no plan-revision engine, reviewed
acceptance, Intercom integration, analytics, or fleet scheduler.

Runtime code uses exactly pinned `absurd-sdk@0.5.0`. Disposable database setup
uses the matching Absurd `0.5.0` schema at
`test/fixtures/absurd-0.5.0.sql`. npm registry `gitHead`, release tag, source URL,
checksum, and Apache-2.0 attribution are recorded in
`test/fixtures/PROVENANCE.md`. No local Absurd checkout or schema fetch is
required.

## Install and verify

Requirements: Node 22.18+ and a working Docker daemon.

```bash
npm ci
npm run typecheck
npm test
```

Tests start isolated `postgres:16-alpine` Testcontainers, verify the pinned schema checksum/version, and stop only resources they created. They never use a host or production database.

This release is installed from a local working tree:

```bash
pi install /absolute/path/to/pi-spool
pi list
```

A local-path Pi package is a reference to the live source directory, not an immutable copied or registry-pinned distribution. Later edits in that directory can affect a future Pi process or reload. Review and retain the exact Git tag/commit separately when reproducibility matters.

To remove the package registration:

```bash
pi remove /absolute/path/to/pi-spool
```

Removing the package does not remove `spool.json`, stop PostgreSQL, or delete durable data.

## Machine configuration

Spool reads `<Pi agent dir>/spool.json` lazily on the first `spool` action that needs the service. It uses Pi's public `getAgentDir()` resolver; the usual path is `~/.pi/agent/spool.json`.

```json
{
  "databaseUrl": "postgresql://spool:spool@127.0.0.1:55432/spool",
  "queueName": "spool_dev"
}
```

Only the two string keys shown above are accepted. Protect the file because the database URL may contain credentials:

```bash
chmod 600 ~/.pi/agent/spool.json
```

`SPOOL_DATABASE_URL` overrides `databaseUrl` and `SPOOL_QUEUE` overrides `queueName` independently. If both environment variables exist, Spool does not read the file. Missing or malformed configuration fails only when Spool is used and never echoes the configured database URL. Ordinary Pi loading, session restoration, and package discovery do not open a database connection.

Configuration never selects a project/profile, routes queues dynamically, applies schemas, creates queues, or attaches work. Spool remains opt-in: the agent must explicitly call `attach`; the extension does not observe, track, or mutate ordinary work automatically.

## Local Docker database

```bash
docker compose up -d --wait

docker compose exec -T postgres psql -U spool -d spool \
  -c "select absurd.get_schema_version();" \
  -c "select queue_name from absurd.queues;"
```

`compose.yaml` starts Postgres 16 on **127.0.0.1:55432 only**, with database/user/password `spool` (local development credentials, not for production). `restart: unless-stopped` lets this explicitly enabled local service return after a machine or Docker restart, but a manual `docker compose stop` keeps it stopped. The named volume `pi-spool-dev_pgdata` retains work across container restarts and removal. It is separate from the disposable Testcontainers databases used by `npm test`.

On a **fresh volume**, the official Postgres entrypoint applies these files in order:

1. `test/fixtures/absurd-0.5.0.sql` — the pinned upstream Absurd schema/functions;
2. `sql/spool.sql` — the extension-owned tables;
3. `sql/dev-queue.sql` — creates the unpartitioned `spool_dev` queue.

This follows Absurd's supported [direct SQL onboarding](https://github.com/earendil-works/absurd/blob/550d3b9e6f9382d96178de6ab8c90c7f8edf2227/docs/database.md). No checkout, `absurdctl` installation, or schema download is needed. Initialization files do **not** run again on an existing volume; future schema changes need an explicit migration, not merely a restart. Inspect failures with `docker compose logs postgres`.

```bash
docker compose stop          # stop; keep container and data
docker compose up -d --wait  # start; keep data
docker compose down          # remove container/network; keep data
# DESTRUCTIVE: only if intentionally discarding all local Spool work:
# docker compose down -v
```

## Database failure bounds

The owned PostgreSQL pool uses a 3-second connection/acquisition timeout, a server-side 10-second timeout for each SQL statement, a 10-second idle-in-transaction timeout, a 12-second client query-read timeout, and a 15-second pool-close deadline. These are per connection or statement, not one aggregate deadline for a multi-statement Spool action.

When PostgreSQL is absent, stopped, unreachable, or a statement blocks, the tool fails instead of waiting indefinitely. It does not retry mutations automatically. Start the configured Compose service if needed, then inspect durable Spool state before retrying.

A timeout only bounds how long Spool waits. It does not prove that a server-side effect failed, and a lost `COMMIT` acknowledgement may mean the transaction committed. Spool reports that outcome as uncertain; inspect state before repeating the action. The client query-read timeout is not claimed to cancel an effect that the server may already have committed.

## Tool contract

The single `spool` tool has these actions:

- `attach`: validate an absolute canonical PKM task file and its frontmatter
  `id`, then store only vault/task/path plus a concise outcome.
- `materialize`: admit one stable step with title, contribution, and completion
  criteria. Transactional SDK spawn uses a stable idempotency key.
- `claim`: claim the **next** ready queue item, optionally checking an expected
  step. A mismatch rolls back the entire claim and is surfaced.
- `checkpoint`: persist a bounded evidence reference and next action while the
  current session/runtime still owns a valid lease.
- `heartbeat`: explicitly renew a still-valid lease. There is no idle timer.
- `status` / `resume`: return a bounded goal reference, step meaning/state,
  latest attempt, checkpoint references, and next action. The active/bound step
  is prioritized; aggregate byte limits add explicit step/checkpoint omission
  counts and text-truncation counts instead of silently cutting JSON.
- `complete`: mark execution complete. It never records reviewed acceptance.

Pi identity is taken from public runtime context:
`ctx.sessionManager.getSessionId()`, `getSessionFile()`, and
`pi.getSessionName()`. Tool parameters cannot supply session, attempt, task-run,
or runtime ownership IDs. A random extension-runtime ID prevents a reload/forked
runtime from reusing a process-local attempt merely because the Pi session ID
matches.

A custom Pi entry stores goal/step lineage. `session_start` and `session_tree`
restore the active branch's entry without opening the database; the first tool
use lazily opens the configured pool and reconciles the entry against durable
state. The custom entry never restores lease authority. Binding-dependent tool
calls are serialized per extension runtime so parallel Pi tool execution cannot
change a binding midway through an operation. `session_shutdown` closes an
opened pool idempotently but does not mark work complete; abrupt loss remains
recoverable through Absurd.

Agent guidance is in `skills/spool/SKILL.md` and active tool prompt guidance.

## SDK and SQL boundary

Packaged SDK methods are exercised for queue management in setup/tests,
idempotent spawn, connection-bound transactional claim, and task-result
operations in the recovery regression. `absurd-sdk@0.5.0` exposes heartbeat and
checkpoints only on handler-owned `TaskContext`; it has no public completion
method. The interactive adapter therefore calls these public SQL functions
inside its transactions: `extend_claim`, `set_task_checkpoint_state`,
`get_task_checkpoint_states`, and `complete_run`. No artificial task-handler
machinery hides that boundary.

## Proven behavior

Automated tests cover:

- strict action-specific parameter validation and canonical PKM ID validation;
- binding restoration and real caller identity extraction from mocked public Pi
  context;
- one-tool registration, resource-lazy startup, and idempotent shutdown;
- stable step admission/spawn without duplicate Absurd tasks;
- claim plus Spool attempt correlation in one transaction;
- a two-ready-item head mismatch whose claim rolls back without stealing or
  stranding either task;
- checkpoint/status/resume reconstruction from a fresh service instance;
- owned-active, expired-active, foreign-runtime, and ready-step next-action
  priority without treating an expired attribution as usable ownership;
- bound-step preservation beyond the first 20 rows plus explicit omissions;
- deterministic 12 KB resume-packet / 16 KB rendered-output bounds under large
  checkpoint references;
- rejection of cross-session/runtime, stale, and locally expired mutations;
- valid-lease duplicate-claim rejection and same-runtime reclaim after expiry
  with checkpoint preservation and new-attempt attribution;
- database enforcement against simultaneous same-session/different-runtime
  active claims, and extension serialization of parallel binding operations;
- explicit heartbeat and replacement claims after expiry;
- execution completion reported separately from unrecorded acceptance;
- the original Absurd recovery regression, including its upstream pre-sweep
  resurrection behavior and post-takeover stale-run rejection.

## Limits

- **Resume is a bounded summary, not history.** It selects at most 20 prioritized
  steps and 20 checkpoints per selected latest attempt, then enforces the byte
  cap. Omission/truncation counts are explicit, but v0 has no pagination or
  narrow-history query yet.
- **Prefer one active goal.** All work currently shares one configured queue,
  and claim is queue-first rather than by nominated task ID. Another goal's
  queue head can block the attached goal; on mismatch Spool rolls back and
  stops. It does not defer, loop, reassign, create per-step queues, or schedule
  around the conflict.
- **Expiry requires an explicit re-poll.** Spool refuses to renew or mutate once
  its conservatively recorded lease expires. The same runtime may explicitly
  recover: a valid active attempt blocks duplicate claim, while an expired one
  does not. With Absurd's real clock, the first claim poll after expiry may only
  fence the old run and enqueue the replacement; Spool then marks the ended
  local attempt lost, and a later explicit claim takes the new run. No hidden
  polling or renewal loop exists.
- **Upstream pre-sweep behavior still exists.** Raw Absurd public SQL can accept
  an expired-but-unswept run. Spool's owned mutation path fails closed before
  calling it, but this is not a second distributed lease engine or database
  fence against another direct SQL caller.
- **Checkpointing remains at-least-once around effects.** A crash after an
  external effect but before checkpoint commit can repeat the effect. Spool
  cannot intercept arbitrary shell effects; external systems still need stable
  application idempotency.
- **Completion is not evidence acceptance.** The schema and tool record only
  execution completion. Reviewed acceptance and transactional review evidence
  are not implemented or claimed.
- **Revision, timeline, and today views are absent.** Minimal attempt rows retain
  only the latest transition/checkpoint summary needed by this loop. Plan
  revision, ordered history/timeline, usage, and today/attention views remain
  future work.
- **Live proof is graceful-restart only.** A controlled live Pi restart reused
  the saved session, acquired replacement run attempt 2, and recovered the
  original checkpoint. Actual SIGKILL recovery and independent continuation
  from a fresh Pi session remain unproven; fork behavior is not accepted.
- **The local install is mutable source.** `pi install /absolute/path` references
  this working tree rather than an immutable package artifact. The Git tag is
  the release baseline, but Pi does not pin the live local directory to it.
- **Spool is never automatic.** It does not observe prompts, infer goals, attach,
  materialize, checkpoint, or complete unless the agent explicitly invokes the
  tool under the documented contract.
