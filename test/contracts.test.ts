import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  restoreBinding,
  validateCanonicalTaskReference,
  type SessionBinding,
} from "../src/binding.ts";
import {
  getSpoolConfigPath,
  readSpoolConfig,
} from "../src/config.ts";
import { spoolParameters } from "../src/index.ts";
import { parseSpoolToolInput } from "../src/tool-contract.ts";

test("tool action validation is strict and action-specific", () => {
  assert.deepEqual(
    parseSpoolToolInput({
      action: "claim",
      expectedStepId: "verify-recovery",
    }),
    {
      action: "claim",
      expectedStepId: "verify-recovery",
      leaseSeconds: 30,
    },
  );
  assert.deepEqual(
    parseSpoolToolInput({
      action: "complete",
      summary: "Recovery proof executed successfully",
      resultRef: "git:abc123",
    }),
    {
      action: "complete",
      summary: "Recovery proof executed successfully",
      resultRef: "git:abc123",
    },
  );
  assert.throws(
    () =>
      parseSpoolToolInput({
        action: "complete",
        outcome: "wrong field",
        summary: "Recovery proof executed successfully",
        resultRef: "git:abc123",
      }),
    /complete does not accept outcome/,
  );
  assert.throws(
    () => parseSpoolToolInput({ action: "status", resultRef: "unexpected" }),
    /does not accept resultRef/,
  );
  assert.throws(
    () => parseSpoolToolInput({ action: "materialize", stepId: "bad id" }),
    /stepId must be/,
  );
  assert.throws(
    () => parseSpoolToolInput({ action: "heartbeat", leaseSeconds: 0 }),
    /leaseSeconds/,
  );
});

test("advertised field constraints match strict complete boundaries", () => {
  const fields = spoolParameters.properties as Record<
    string,
    {
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      minimum?: number;
      maximum?: number;
    }
  >;
  const caps: Record<string, number> = {
    vault: 100,
    taskId: 100,
    canonicalPath: 2_000,
    outcome: 500,
    stepId: 100,
    title: 200,
    contribution: 500,
    criteria: 500,
    expectedStepId: 100,
    checkpointName: 100,
    evidenceRef: 1_000,
    nextAction: 500,
    resultRef: 1_000,
    summary: 500,
  };
  for (const [field, maxLength] of Object.entries(caps)) {
    assert.equal(fields[field]?.minLength, 1, `${field} minLength drifted`);
    assert.equal(
      fields[field]?.maxLength,
      maxLength,
      `${field} maxLength drifted`,
    );
  }
  for (const field of ["stepId", "expectedStepId", "checkpointName"]) {
    assert.equal(
      fields[field]?.pattern,
      "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
      `${field} identifier pattern drifted`,
    );
  }
  assert.equal(fields.leaseSeconds?.minimum, 1);
  assert.equal(fields.leaseSeconds?.maximum, 3_600);
  assert.doesNotThrow(() =>
    parseSpoolToolInput({
      action: "complete",
      summary: "s".repeat(500),
      resultRef: "r".repeat(1_000),
    }),
  );
  assert.throws(
    () =>
      parseSpoolToolInput({
        action: "complete",
        summary: "s".repeat(501),
        resultRef: "result",
      }),
    /summary must be a non-empty string up to 500 characters/,
  );
  assert.throws(
    () =>
      parseSpoolToolInput({
        action: "complete",
        summary: "done",
        resultRef: "r".repeat(1_001),
      }),
    /resultRef must be a non-empty string up to 1000 characters/,
  );
});

test("binding restoration selects the latest valid custom entry", () => {
  const older: SessionBinding = {
    version: 1,
    workId: "work_old",
    vault: "vault",
    taskId: "OLD-1",
    canonicalPath: "/tmp/old.md",
  };
  const latest: SessionBinding = {
    version: 1,
    workId: "work_new",
    vault: "vault",
    taskId: "NEW-1",
    canonicalPath: "/tmp/new.md",
    stepId: "step-1",
  };
  assert.deepEqual(
    restoreBinding([
      { type: "custom", customType: "spool-binding", data: older },
      { type: "message" },
      { type: "custom", customType: "spool-binding", data: latest },
    ]),
    latest,
  );
  assert.equal(
    restoreBinding([
      { type: "custom", customType: "spool-binding", data: { version: 99 } },
    ]),
    null,
  );
});

test("canonical attachment validates the frontmatter task ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-spool-task-"));
  const path = join(directory, "ALD-1.md");
  try {
    await writeFile(path, "---\nid: ALD-1\nstatus: open\n---\n\n# Goal\n", "utf8");
    assert.deepEqual(
      await validateCanonicalTaskReference({
        vault: "zeebs_sb",
        taskId: "ALD-1",
        canonicalPath: path,
      }),
      { vault: "zeebs_sb", taskId: "ALD-1", canonicalPath: path },
    );
    await assert.rejects(
      validateCanonicalTaskReference({
        vault: "zeebs_sb",
        taskId: "OTHER-1",
        canonicalPath: path,
      }),
      /canonical task ID mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("machine config is explicit and environment keys override individually", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-spool-config-"));
  const configPath = getSpoolConfigPath(directory);
  try {
    assert.throws(
      () => readSpoolConfig({}, directory),
      /Spool is not configured.*spool\.json/,
    );
    await writeFile(
      configPath,
      JSON.stringify({
        databaseUrl: "postgresql://file.example/spool",
        queueName: "file_queue",
      }),
      "utf8",
    );
    assert.deepEqual(readSpoolConfig({}, directory), {
      databaseUrl: "postgresql://file.example/spool",
      queueName: "file_queue",
    });
    assert.deepEqual(
      readSpoolConfig(
        { SPOOL_DATABASE_URL: "postgresql://env.example/spool" },
        directory,
      ),
      {
        databaseUrl: "postgresql://env.example/spool",
        queueName: "file_queue",
      },
    );
    assert.deepEqual(
      readSpoolConfig({ SPOOL_QUEUE: "env_queue" }, directory),
      {
        databaseUrl: "postgresql://file.example/spool",
        queueName: "env_queue",
      },
    );

    await writeFile(
      configPath,
      '{"databaseUrl":"postgresql://user:TOPSECRET@example/spool",',
      "utf8",
    );
    assert.throws(
      () => readSpoolConfig({}, directory),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid Spool config/);
        assert.doesNotMatch(error.message, /TOPSECRET/);
        return true;
      },
    );
    assert.deepEqual(
      readSpoolConfig(
        {
          SPOOL_DATABASE_URL: "postgresql://env.example/spool",
          SPOOL_QUEUE: "env_queue",
        },
        directory,
      ),
      {
        databaseUrl: "postgresql://env.example/spool",
        queueName: "env_queue",
      },
      "complete environment configuration does not read the machine file",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("database URL and queue values fail validation without secret echo", () => {
  assert.throws(
    () =>
      readSpoolConfig({
        SPOOL_DATABASE_URL: "not-a-postgres-url-with-TOPSECRET",
        SPOOL_QUEUE: "spool_dev",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /valid postgres/);
      assert.doesNotMatch(error.message, /TOPSECRET/);
      return true;
    },
  );
  assert.throws(
    () =>
      readSpoolConfig({
        SPOOL_DATABASE_URL: "postgresql://example/spool",
        SPOOL_QUEUE: "Bad-Queue",
      }),
    /queueName/,
  );
});
