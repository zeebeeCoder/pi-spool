#!/usr/bin/env node
// Harness-neutral CLI over the Spool work log, for agents that are not Pi
// (Claude Code, shell scripts, cron). Same three actions, same database.
//
//   node bin/spool.ts resume [--path <task.md> | --task <ID> [--vault <v>] | --all]
//   node bin/spool.ts note --task <ID> --step <id> --summary <text> [--title t] [--evidence ref] [--next text] [--vault v]
//   node bin/spool.ts done --task <ID> --step <id> --summary <text> [--evidence ref] [--reviewed] [--vault v]
//
// Identity, first match wins:
//   --session <id> / --name <name>
//   SPOOL_SESSION_ID / SPOOL_SESSION_NAME
//   CLAUDE_SESSION_ID (name "claude-code")
//   <user>@<host>:<cwd basename>:<YYYY-MM-DD>   stable across calls in one directory and day
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { readCanonicalTaskReference } from "../src/binding.ts";
import { readSpoolConfig } from "../src/config.ts";
import { SpoolService, type RuntimeIdentity, type WorkRecord } from "../src/spool-service.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    path: { type: "string" },
    task: { type: "string" },
    vault: { type: "string" },
    all: { type: "boolean", default: false },
    step: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    evidence: { type: "string" },
    next: { type: "string" },
    reviewed: { type: "boolean", default: false },
    outcome: { type: "string" },
    session: { type: "string" },
    name: { type: "string" },
  },
});

const action = positionals[0];
const claudeSession = process.env.CLAUDE_SESSION_ID;
const identity: RuntimeIdentity = {
  piSessionId:
    values.session ??
    process.env.SPOOL_SESSION_ID ??
    (claudeSession ? `claude-code:${claudeSession}` : undefined) ??
    `${userInfo().username}@${hostname()}:${basename(process.cwd())}:${new Date().toISOString().slice(0, 10)}`,
  piSessionName:
    values.name ??
    process.env.SPOOL_SESSION_NAME ??
    (claudeSession ? "claude-code" : null),
  piSessionFile: null,
  runtimeId: "00000000-0000-4000-8000-00000000c11e",
};

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function require(name: string, value: string | undefined): string {
  if (!value) fail(`--${name} is required for ${action}`);
  return value;
}

const service = SpoolService.connect(readSpoolConfig());
try {
  let result: unknown;
  if (action === "resume") {
    if (values.path) {
      const ref = await readCanonicalTaskReference({ canonicalPath: values.path, vault: values.vault });
      const work = await service.attach({ ...ref, outcome: values.outcome ?? ref.title ?? undefined });
      result = await service.resume(bindingOf(work), identity);
    } else if (values.task) {
      result = await service.peek({ taskId: values.task, vault: values.vault }, identity);
    } else {
      result = await service.overview(identity);
    }
  } else if (action === "note" || action === "done") {
    const taskId = require("task", values.task);
    const stepId = require("step", values.step);
    const summary = require("summary", values.summary);
    const view = await service.peek({ taskId, vault: values.vault }, identity);
    const binding = bindingOf(view.goal);
    result =
      action === "note"
        ? await service.note(binding, identity, {
            stepId,
            title: values.title,
            summary,
            evidenceRef: values.evidence,
            nextAction: values.next,
          })
        : await service.done(binding, identity, {
            stepId,
            summary,
            evidenceRef: values.evidence,
            reviewed: values.reviewed,
          });
  } else {
    fail("usage: spool resume [--path|--task|--all] | note --task --step --summary | done --task --step --summary");
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await service.close();
}

function bindingOf(work: WorkRecord) {
  return {
    version: 1 as const,
    workId: work.workId,
    vault: work.vault,
    taskId: work.taskId,
    canonicalPath: work.canonicalPath,
  };
}
