---
name: spool
description: Read and write the Spool work ledger for PKM goals from Claude Code. Use when the user asks what is open, where a goal or task stands, what other agents did, wants to pick up or continue a step, or wants progress recorded. Bridges ledger entries to their spec files in the vault. Never a gate on doing work.
allowed-tools: Bash, Read
---

# Spool

Spool is a work log in Postgres. A goal is a PKM task file with an `id` in
its frontmatter. Steps are named by whoever works on them. Every entry carries
the session that wrote it, so the ledger shows what each agent did for a goal.

Command from any directory:

```bash
node ~/code/opti/pi-spool/bin/spool.ts <action> [flags]
```

Output is JSON. Identity: pass `--session <id> --name claude-code` using the
session id from your context (the `Claude-Session` URL's last segment). If you
have none, omit both; the fallback is stable per directory and day.

## Moves

**Overview.** User asks what is open, what happened, where things stand.

```bash
node ~/code/opti/pi-spool/bin/spool.ts resume
```

Returns every goal with counts, current step, its last summary, next action,
and `canonicalPath`. Report goals with open steps first. Do not paste the JSON;
summarise in a short table or list.

**One goal.** User names a task ID (`ALD-1`, `NFN-9`) or a spec.

```bash
node ~/code/opti/pi-spool/bin/spool.ts resume --task NFN-9
```

Then `Read` the `canonicalPath` from the result for the spec itself. The spec
holds intent and the session log; the ledger holds attributed step events.
Present both: what the spec asked for, what the ledger says was done, by whom,
and the recorded next action. If the same task ID exists in two vaults the CLI
says so; add `--vault <name>`.

**Note.** A milestone reached, or you are stopping and someone else continues.

```bash
node ~/code/opti/pi-spool/bin/spool.ts note --task ALD-1 --step <stepId> \
  --summary "<what happened>" --evidence "<commit, path, or task id>" \
  --next "<what a resuming session should do>" --session <id> --name claude-code
```

An unknown `stepId` creates the step; add `--title` then. Keep summaries to
one or two sentences. Two or three notes per step is typical.

**Done.** A step's work is finished.

```bash
node ~/code/opti/pi-spool/bin/spool.ts done --task ALD-1 --step <stepId> \
  --summary "<result>" --evidence "<commit or path>" --session <id> --name claude-code
```

Add `--reviewed` only when the user says the result is accepted.

## Picking up a step

User asks to continue, take over, or finish a step or goal.

1. `resume --task <ID>`, then `Read` the spec at `canonicalPath`. The spec
   holds intent and acceptance; the ledger holds where the last session
   stopped and its `nextAction`. Start from the next action unless the user
   says otherwise.
2. Before changing anything, `note` on that step: one line saying you picked
   it up and what you intend, with `--next` set to the first concrete move.
3. Do the work in the repo. Checkpoint with `note` at milestones and whenever
   you stop, always with a `--next` and an `--evidence` (commit, file, test).
4. When the step's acceptance is met, `done` with the commit or artifact as
   evidence. Leave `--reviewed` off; the user grants that.
5. `done` closes a step, not the goal. Task status lives in the vault: hand
   that to `pkm task` or the `code-session` skill.

Your checkpoints are the notes you write. There is no automatic resume if the
session dies, so note before any long or risky stretch.

## Rules

- Never block work on the ledger. If the database is unreachable the CLI says
  so; mention it once and continue the task.
- A `warning` in a result means another session touched the step recently or
  it was already done. It is information. Mention it, do not stop.
- Do not create or edit PKM task files here. Creating tasks, changing status,
  and session handoff belong to `pkm task` and the `code-session` skill.
- Do not log routine tool calls or reasoning. Log outcomes.
