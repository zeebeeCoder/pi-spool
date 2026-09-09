import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_PKM_GOAL_CHARS,
  MAX_PKM_TASK_BYTES,
  PkmReferenceReader,
  extractGoalSection,
  parsePkmTaskReference,
} from "../src/pkm-reference.ts";

test("PKM attribution uses public frontmatter semantics and a bounded Goal section", () => {
  const parsed = parsePkmTaskReference(
    `---\nid: ALD-1\ntitle: Durable workflow browser\nproject: alpha-desk\n---\n\n# Durable workflow browser\n\n## Goal\n\nMake durable work understandable.\n\nKeep acceptance separate.\n\n## Scope\n\nNot part of goal.\n`,
    "/vault/tasks/ALD-1.md",
    "ALD-1",
  );
  assert.deepEqual(parsed, {
    status: "available",
    canonicalPath: "/vault/tasks/ALD-1.md",
    expectedTaskId: "ALD-1",
    fileTaskId: "ALD-1",
    title: "Durable workflow browser",
    project: "alpha-desk",
    goalText: "Make durable work understandable.\n\nKeep acceptance separate.",
    notice: "PKM attribution verified against the recorded task ID",
  });

  const longGoal = extractGoalSection(
    `## Goal\n${"żółć ".repeat(MAX_PKM_GOAL_CHARS)}\n## Next\nignored`,
  );
  assert.match(longGoal ?? "", /Goal text truncated/);
  assert.ok((longGoal?.length ?? 0) < MAX_PKM_GOAL_CHARS + 100);
});

test("PKM task mismatch and malformed frontmatter fail closed to attribution fallback", () => {
  const mismatch = parsePkmTaskReference(
    "---\nid: OTHER-1\ntitle: Wrong task\nproject: wrong\n---\n## Goal\nWrong goal",
    "/vault/tasks/ALD-1.md",
    "ALD-1",
  );
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.fileTaskId, "OTHER-1");
  assert.equal(mismatch.title, null);
  assert.equal(mismatch.goalText, null);
  assert.match(mismatch.notice, /does not match/);

  const malformed = parsePkmTaskReference(
    "---\nid: [unterminated\n---\n# Broken",
    "/vault/tasks/ALD-1.md",
    "ALD-1",
  );
  assert.equal(malformed.status, "malformed");
  assert.equal(malformed.title, null);
});

test("bounded lazy PKM reader handles valid, missing, invalid, and oversized paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-spool-pkm-"));
  const validPath = join(directory, "PKM-1.md");
  const oversizedPath = join(directory, "PKM-2.md");
  const missingPath = join(directory, "missing.md");
  try {
    await writeFile(
      validPath,
      "---\nid: PKM-1\ntitle: Read me\nproject: test\n---\n## Goal\nProve bounded reads.",
    );
    await writeFile(oversizedPath, "x".repeat(MAX_PKM_TASK_BYTES + 1));
    const reader = new PkmReferenceReader();
    assert.equal((await reader.read(validPath, "PKM-1")).status, "available");
    assert.equal((await reader.read(missingPath, "PKM-1")).status, "missing");
    assert.equal((await reader.read("relative/task.md", "PKM-1")).status, "invalid_path");
    const oversized = await reader.read(oversizedPath, "PKM-2");
    assert.equal(oversized.status, "oversized");
    assert.match(oversized.notice, new RegExp(String(MAX_PKM_TASK_BYTES)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
