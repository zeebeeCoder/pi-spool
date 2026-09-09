import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  readCanonicalTaskReference,
  restoreBinding,
  vaultFromPath,
} from "../src/binding.ts";
import { readSpoolConfig } from "../src/config.ts";
import { SPOOL_PROMPT_GUIDELINES, spoolParameters } from "../src/index.ts";
import { parseSpoolToolInput } from "../src/tool-contract.ts";

test("tool input accepts the three actions and rejects foreign fields", () => {
  assert.deepEqual(parseSpoolToolInput({ action: "resume" }), { action: "resume" });
  assert.deepEqual(
    parseSpoolToolInput({ action: "resume", canonicalPath: "/v/tasks/T-1.md" }),
    { action: "resume", canonicalPath: "/v/tasks/T-1.md" },
  );
  assert.deepEqual(
    parseSpoolToolInput({ action: "note", stepId: "s1", summary: "started" }),
    { action: "note", stepId: "s1", summary: "started" },
  );
  assert.deepEqual(
    parseSpoolToolInput({ action: "done", stepId: "s1", summary: "finished", reviewed: true }),
    { action: "done", stepId: "s1", summary: "finished", reviewed: true },
  );
  assert.deepEqual(
    parseSpoolToolInput({ action: "resume", taskId: "NFN-3", vault: "nfhotel_sb" }),
    { action: "resume", taskId: "NFN-3", vault: "nfhotel_sb" },
  );
  assert.deepEqual(parseSpoolToolInput({ action: "resume", scope: "all" }), { action: "resume", scope: "all" });
  assert.throws(() => parseSpoolToolInput({ action: "resume", scope: "mine" }), /scope must be goal or all/);
  assert.throws(
    () => parseSpoolToolInput({ action: "resume", canonicalPath: "/a.md", taskId: "T" }),
    /either canonicalPath .* or taskId/,
  );
  assert.throws(() => parseSpoolToolInput({ action: "claim" }), /unsupported spool action/);
  assert.throws(() => parseSpoolToolInput({ action: "note", summary: "x" }), /requires stepId/);
  assert.throws(
    () => parseSpoolToolInput({ action: "done", stepId: "s1", summary: "x", nextAction: "y" }),
    /nextAction is not accepted/,
  );
  assert.throws(
    () => parseSpoolToolInput({ action: "note", stepId: "-bad", summary: "x" }),
    /stepId must start/,
  );
  assert.throws(
    () => parseSpoolToolInput({ action: "note", stepId: "s1", summary: "" }),
    /summary must be a non-empty string/,
  );
  assert.throws(
    () => parseSpoolToolInput({ action: "note", stepId: "s1", summary: "x".repeat(501) }),
    /summary exceeds 500/,
  );
  assert.throws(
    () => parseSpoolToolInput({ action: "done", stepId: "s1", summary: "x", reviewed: "yes" }),
    /reviewed must be a boolean/,
  );
});

test("advertised schema and parser agree on limits", () => {
  const properties = spoolParameters.properties as Record<string, { maxLength?: number }>;
  assert.equal(properties.summary?.maxLength, 500);
  assert.equal(properties.evidenceRef?.maxLength, 1_000);
  assert.equal(properties.stepId?.maxLength, 100);
  assert.deepEqual(Object.keys(properties).sort(), [
    "action",
    "canonicalPath",
    "evidenceRef",
    "nextAction",
    "outcome",
    "reviewed",
    "scope",
    "stepId",
    "summary",
    "taskId",
    "title",
    "vault",
  ]);
});

test("prompt guidance frames spool as a log, never a gate", () => {
  const text = SPOOL_PROMPT_GUIDELINES.join(" ");
  assert.match(text, /work log, not a gate/);
  assert.match(text, /never authorizes or blocks/);
  assert.doesNotMatch(text, /claim|lease|heartbeat/);
});

test("binding restoration selects the latest valid custom entry", () => {
  const valid = {
    version: 1,
    workId: "work_a",
    vault: "v",
    taskId: "T-1",
    canonicalPath: "/v/tasks/T-1.md",
  };
  assert.deepEqual(
    restoreBinding([
      { type: "custom", customType: "spool-binding", data: { version: 1, workId: "old" } },
      { type: "message" },
      { type: "custom", customType: "spool-binding", data: valid },
      { type: "custom", customType: "other", data: {} },
    ]),
    valid,
  );
  assert.equal(
    restoreBinding([{ type: "custom", customType: "spool-binding", data: { version: 2 } }]),
    null,
  );
  assert.equal(restoreBinding([]), null);
});

test("canonical task reference derives task ID, vault, and title from the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-spool-vault-"));
  const dir = join(root, "vaults", "zeebs_sb", "tasks");
  await rm(dir, { recursive: true, force: true });
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  const file = join(dir, "ALD-1.md");
  await writeFile(file, "---\nid: ALD-1\ntitle: Build the thing\n---\n\n# Build the thing\n");
  try {
    assert.deepEqual(await readCanonicalTaskReference({ canonicalPath: file }), {
      vault: "zeebs_sb",
      taskId: "ALD-1",
      canonicalPath: file,
      title: "Build the thing",
    });
    assert.equal(
      (await readCanonicalTaskReference({ canonicalPath: file, vault: "explicit" })).vault,
      "explicit",
    );
    await assert.rejects(
      readCanonicalTaskReference({ canonicalPath: "relative/ALD-1.md" }),
      /must be absolute/,
    );
    const noId = join(dir, "noid.md");
    await writeFile(noId, "---\ntitle: nothing\n---\n");
    await assert.rejects(readCanonicalTaskReference({ canonicalPath: noId }), /no id/);
    const outside = join(root, "OUT-1.md");
    await writeFile(outside, "---\nid: OUT-1\n---\n");
    await assert.rejects(
      readCanonicalTaskReference({ canonicalPath: outside }),
      /pass vault explicitly/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(vaultFromPath("/Users/x/vaults/nfhotel_sb/tasks/2026/09/NFN-1.md"), "nfhotel_sb");
  assert.equal(vaultFromPath("/Users/x/notes/NFN-1.md"), null);
});

test("machine config reads databaseUrl and tolerates a stale queueName key", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spool-agent-"));
  try {
    assert.throws(() => readSpoolConfig({}, agentDir), /not configured.*spool\.json/);
    await writeFile(
      join(agentDir, "spool.json"),
      JSON.stringify({ databaseUrl: "postgresql://u:p@127.0.0.1:1/db", queueName: "legacy" }),
    );
    assert.deepEqual(readSpoolConfig({}, agentDir), {
      databaseUrl: "postgresql://u:p@127.0.0.1:1/db",
    });
    assert.deepEqual(
      readSpoolConfig({ SPOOL_DATABASE_URL: "postgres://env/db" }, agentDir),
      { databaseUrl: "postgres://env/db" },
    );
    await writeFile(join(agentDir, "spool.json"), JSON.stringify({ other: 1 }));
    assert.throws(() => readSpoolConfig({}, agentDir), /Invalid Spool config/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("database URL validation never echoes the value", () => {
  for (const bad of ["mysql://secret@host/db", " postgres://x ", ""]) {
    assert.throws(
      () => readSpoolConfig({ SPOOL_DATABASE_URL: bad }),
      (error: Error) => !error.message.includes("secret") && /databaseUrl/.test(error.message),
    );
  }
});
