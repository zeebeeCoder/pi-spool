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

Do not record speculative plans, private reasoning, routine tool calls, or
micro-steps. Spool does not authorize peer launches or arbitrary external
side effects.

## Action fields

Fields are strict, non-empty when supplied, and action-specific. Lengths below
are maximum characters:

- `attach`: required `vault` (100), `taskId` (100), `canonicalPath` (2000), and
  `outcome` (500).
- `materialize`: required `stepId` (100), `title` (200), `contribution` (500),
  and `criteria` (500).
- `claim`: optional `expectedStepId` (100) and `leaseSeconds` (1–3600).
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
4. `claim` the next queue item, optionally naming `expectedStepId`. A queue-head
   mismatch is reported and rolled back; do not loop or silently take another
   item.
5. Work only while the current Pi session and extension runtime own the attempt.
   Use explicit `heartbeat` during bounded long work. This v0 has no idle renewal
   timer.
6. At a meaningful boundary, write a named `checkpoint` with a stable evidence
   reference and next action. A checkpoint is resumable state, not acceptance.
7. Use `resume` after interruption. Inspect before explicitly reclaiming; a
   copied session entry restores lineage, never lease authority. A valid lease
   blocks duplicate claim. After expiry, the first claim may only sweep the lost
   run and return no item; inspect and explicitly claim again rather than loop.
8. Call `complete` only for execution completion. Report review/acceptance as
   unrecorded.

Stop and surface the problem when ownership is lost/uncertain, storage fails, a
decision is missing, or an external effect may have happened without a durable
checkpoint. Spool cannot intercept arbitrary shell effects; use application-owned
idempotency where repetition matters.
