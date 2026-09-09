---
name: spool
description: Log progress on a PKM goal so a later Pi session can resume it. Use at the start of work on a task file, at milestones, and when a step is finished. Never a gate on doing the work.
---

# Spool

Spool is a work log. The PKM task file is the goal, Git holds the code, the Pi
transcript holds the conversation, and Spool holds a short, durable trail of
which steps exist, what happened on them, and what to do next.

It never blocks or authorizes work. If Spool is unreachable, say so once and
continue the task.

## Three actions

- `resume` — where work stands. With no attached goal it returns an overview
  of every goal: counts, last activity, current step, next action, and the
  task file path. Pass `canonicalPath` (absolute path of the task file) to
  attach one goal; the task ID comes from its frontmatter. Pass `taskId` (and
  `vault` if ambiguous) to read another goal without attaching. `scope: "all"`
  returns the overview from an attached session.
- `note` — record progress on a step: `stepId`, `summary`, optional `title`
  (for a new step), `evidenceRef` (commit, file, task ID), and `nextAction`
  (what a resuming session should do). An unknown `stepId` creates the step.
- `done` — mark a step finished: `stepId`, `summary`, optional `evidenceRef`,
  and `reviewed` (true only after a human or coordinator accepted the result).

Field limits: `summary`, `nextAction`, `outcome` 500 chars; `title` 200;
`evidenceRef` 1000; `stepId` 100, starting with a letter or digit and using only
letters, digits, `.`, `_`, `:`, `-`.

## When to log

1. New session, unsure what is in flight: plain `resume` for the overview.
2. Starting on a task: `resume` with `canonicalPath`, then follow `nextAction`.
3. Starting a step or reaching a milestone: one `note` with a `nextAction`.
4. Before stopping for review or handoff: one `note` saying where to pick up.
5. Step finished: `done`.

Do not log routine tool calls, reasoning, or micro-steps. Two or three
entries per step is typical.

## Warnings

A `warning` in a result means another session recently touched the same step,
or the step was already done. It is information, not an error. Mention it once
and continue; coordinate through your normal channel if it matters.
