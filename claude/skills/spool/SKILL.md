---
name: spool
description: Read and write the Spool work ledger for PKM goals from Claude Code. Use when the user asks what is open, where a goal or task stands, what other agents did, or wants progress on a step recorded. Bridges ledger entries to their spec files in the vault. Never a gate on doing work.
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

## Rules

- Never block work on the ledger. If the database is unreachable the CLI says
  so; mention it once and continue the task.
- A `warning` in a result means another session touched the step recently or
  it was already done. It is information. Mention it, do not stop.
- Do not create or edit PKM task files here. Creating tasks, changing status,
  and session handoff belong to `pkm task` and the `code-session` skill.
- Do not log routine tool calls or reasoning. Log outcomes.
