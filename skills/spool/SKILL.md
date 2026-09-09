---
name: spool
description: Preserve consequential coding work across Pi sessions with the experimental Spool tool. Use when a later session depends on a materialized step, a durable wait, or a costly checkpoint; not for ordinary reasoning or routine tool calls.
---

# Spool

Spool is an experimental operational continuity layer. The canonical PKM task
remains the goal/spec, Git remains implementation evidence, Pi JSONL remains the
conversation trace, and Absurd owns task/run/lease/checkpoint state.

## When to use

Materialize work only when a future turn/session depends on it, when it will
wait or retry, or when repeating an effect has meaningful cost. Self-assignment
is the default.

Do not record speculative plans, private reasoning, routine tool calls, or micro-steps. Spool does not authorize peer launches or arbitrary external side effects.

## Tracking versus work authority

Spool is optional continuity unless the user explicitly requires strict tracking. A successful claim authorizes mutations only to the claimed Spool execution record; it does not authorize starting code changes, launching peers, or causing external effects. Those actions require the user's existing instruction or the normal coordinator/worker ownership contract.

When an explicit intended step is verified ready and unowned but another admitted item is at the queue head, a successful rollback returns `claimed:false`, `tracking:"unavailable"`, `reason:"queue_head_mismatch"`, and `rollback:"confirmed"` with intended/head references and a `nextAction`. Report this non-error tracking limitation once. If the underlying work is otherwise authorized, continue it through normal coordination and describe it as untracked; do not repeatedly claim, wait, sweep, reorder, cancel, or take the unrelated queue head just to satisfy Spool. If strict tracking was explicitly required, pause and ask instead.

This optional fallback does not apply without an explicit intended step or when ownership/admission is ambiguous. A real same-step owner, a lost lease after ownership was acquired, storage or rollback failure, and an external effect/commit with uncertain outcome remain hard errors. Inspect durable state where safe, and never invent ownership or completion.

## Action fields

Fields are strict, non-empty when supplied, and action-specific. Lengths below
are maximum characters:

- `attach`: required `vault` (100), `taskId` (100), `canonicalPath` (2000), and
  `outcome` (500).
- `materialize`: required `stepId` (100), `title` (200), `contribution` (500),
  and `criteria` (500).
- `claim`: optional `expectedStepId` (100) and `leaseSeconds` (1–3600).
- `report`: required `stepId` (100), `disposition` (`in_progress` or `finished`), `summary` (500), `evidenceRef` (1000); optional `nextAction` (500).
- `checkpoint`: required `checkpointName` (100) and `evidenceRef` (1000);
  optional `nextAction` (500).
- `heartbeat`: optional `leaseSeconds` (1–3600).
- `status` and `resume`: no additional fields.
- `complete`: required `summary` (500) and `resultRef` (1000). Do not pass
  `outcome`, which belongs only to `attach`.

`stepId`, `expectedStepId`, and `checkpointName` must start with a letter or
number; remaining characters may be letters, numbers, `.`, `_`, `:`, or `-`.

Valid completion input:

```json
{"action":"complete","summary":"Recovery proof executed successfully","resultRef":"git:abc123"}
```

## Single-agent loop

1. Call `spool` with `action=attach`, the explicit vault/task ID, absolute
   canonical task path, and a concise desired outcome.
2. Inspect with `status` or `resume` before changing work.
3. `materialize` one stable step with its contribution and completion criteria.
4. `claim` the next queue item, naming `expectedStepId` when a safe optional fallback is needed. Handle the stable `claimed:false` / `tracking:"unavailable"` / `reason:"queue_head_mismatch"` result once and follow its `nextAction`; do not loop or silently take another item. Continue already authorized work untracked unless strict tracking was explicitly required. A missing expected step, hard error, or ordinary no-item result is not this fallback.
5. For tracked execution, checkpoint, heartbeat, and complete only while the current Pi session and extension runtime own the attempt. Use explicit `heartbeat` during bounded long work; this v0 has no idle renewal timer. If step 4 took the optional untracked fallback, skip attempt-bound Spool actions rather than withholding otherwise authorized work. To attribute actual work already underway or finished without a lease, use `report` with the explicit materialized `stepId`; its first safe write withdraws only that step's pending queue task. A report is untracked, reporter-attributed evidence—not an attempt, verified truth, duration, or acceptance—and ownership/cancellation uncertainty must fail closed.
6. At a meaningful boundary, write a named `checkpoint` with a stable evidence
   reference and next action. A checkpoint is resumable state, not acceptance.
7. Use `resume` after interruption. Inspect before explicitly reclaiming; a
   copied session entry restores lineage, never lease authority. A valid lease
   blocks duplicate claim. After expiry, the first claim may only sweep the lost
   run and return no item; inspect and explicitly claim again rather than loop.
8. Call `complete` only for execution completion. Report review/acceptance as
   unrecorded.

Stop and surface the problem when actual ownership is lost or uncertain, storage fails, a decision is missing, or an external effect may have happened without a durable checkpoint. Spool cannot intercept arbitrary shell effects; use application-owned idempotency where repetition matters. A fully rolled-back queue-head mismatch with no acquired ownership or external effect is a tracking limitation, not an authority failure for otherwise authorized work.
