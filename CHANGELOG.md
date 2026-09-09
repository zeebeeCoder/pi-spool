# Changelog

## Unreleased

- Absurd returns as the execution layer for unattended pods. `worker/pod.ts`
  runs a headless Pi session as Absurd task `spool-pod` on queue `spool_pods`
  with per-message checkpoints, retry, and an awaitable result; Spool records
  start, retry, and done. The vendored schema lives in `sql/vendor` with a
  checksum test, and compose installs it plus the queue on a fresh volume.
- Phase 1 kill test passed: SIGKILL at message 17, attempt 2 resumed from the
  same session file with no repeated tool call.
- `fanout`: a coordinator task on queue `spool_fanout` creates a worktree per
  pod, spawns pods idempotently, and awaits each result as a checkpoint.
  Phase 2 kill test passed with the coordinator and three pods in flight.

## 0.2.0-experimental.1 — 2026-09-09

Thin work log. Replaces the Absurd-backed lease and claim protocol.

- `spool` has three actions: `resume`, `note`, `done`. Removed: `attach`,
  `materialize`, `claim`, `report`, `checkpoint`, `heartbeat`, `status`,
  `complete`. Attachment happens through `resume` with `canonicalPath`; the
  task ID is read from the file's frontmatter.
- Storage is an append-only `spool.events` table plus `works` and `steps`.
  Step state is derived from the latest event. No queue, lease, or attempt.
- Concurrent sessions on one step receive an advisory `warning`; no write is
  ever refused on ownership grounds.
- `resume` is capped at 12 steps and 6 KB. Tool output cap is 8 KB.
- Dropped `absurd-sdk` and the vendored Absurd schema. `spool.json` needs only
  `databaseUrl`; a stale `queueName` is ignored.
- `sql/migrations/002-thin-events.sql` migrates a v1 database additively and
  backfills history from attempts, reports, and Absurd checkpoints.
- `/spool` browser shows goals, steps, and per-step history; sort cycling and
  the technical-details toggle are gone.
- `resume` with no attached goal returns an overview of every goal; `taskId`
  peeks at another goal without attaching; `scope: "all"` forces the overview.
- `bin/spool.ts` (`npm run spool`) exposes the same three actions to non-Pi
  agents such as Claude Code, with identity from `SPOOL_SESSION_ID`.

Why: in live use on 2026-09-09 a single shared FIFO queue let one goal's
unclaimed step block two other goals, a mismatched claim rolled back Absurd's
expiry sweep so a stale lease could never clear, and the protocol consumed the
agent's attention. See README "Why v2 replaced the Absurd-backed v1".

## 0.1.0-experimental.1 — 2026-09-09

First controlled experimental release of the single-agent `spool` tool backed
by Absurd 0.5.0 with attach, materialize, claim, checkpoint, heartbeat, status,
resume, report, and complete.
