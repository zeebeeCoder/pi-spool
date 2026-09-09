import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TOOL_OUTPUT_BYTES,
  renderSpoolResult,
} from "../src/index.ts";
import {
  MAX_RESUME_PACKET_BYTES,
  boundResumePacket,
  resumePacketBytes,
  type ResumePacket,
} from "../src/spool-service.ts";

function largePacket(): ResumePacket {
  return {
    goal: {
      workId: "work_bound",
      vault: "zeebs_sb",
      taskId: "ALD-1",
      canonicalPath: "/vault/tasks/ALD-1.md",
      outcome: "preserve the current active step while bounding output",
    },
    steps: Array.from({ length: 20 }, (_, stepIndex) => ({
      stepId: `step-${stepIndex}`,
      title: `Step ${stepIndex}`,
      contribution: "c".repeat(500),
      criteria: "k".repeat(500),
      state: stepIndex === 0 ? "running" : "ready",
      latestAttempt:
        stepIndex === 0
          ? {
              attemptId: "attempt-active",
              attempt: 1,
              piSessionId: "session-a",
              piSessionName: "active",
              state: "active",
              leaseExpiresAt: new Date("2026-09-08T13:00:00Z"),
              leaseValid: true,
              attributedToCurrentRuntime: true,
              ownedByCurrentRuntime: true,
              lastTransition: "checkpointed",
              lastSummary: "active summary",
              nextAction: "continue active step",
            }
          : null,
      checkpoints: Array.from({ length: 20 }, (_, checkpointIndex) => ({
        name: `checkpoint-${stepIndex}-${checkpointIndex}`,
        evidenceRef: `sha256:${"e".repeat(990)}`,
        recordedAt: "2026-09-08T12:00:00.000Z",
      })),
    })),
    nextAction: "continue active step",
    acceptance: "not_recorded",
    omissions: { steps: 5, checkpoints: 7, textFields: 0, notice: null },
  };
}

test("large resume packets are deterministically bounded with omissions", () => {
  const bounded = boundResumePacket(largePacket());
  assert.ok(resumePacketBytes(bounded) <= MAX_RESUME_PACKET_BYTES);
  assert.equal(bounded.steps[0]?.stepId, "step-0");
  assert.equal(bounded.steps[0]?.latestAttempt?.ownedByCurrentRuntime, true);
  assert.equal(bounded.nextAction, "continue active step");
  assert.ok(bounded.omissions.checkpoints > 7 || bounded.omissions.steps > 5);
  assert.match(bounded.omissions.notice ?? "", /Bounded view omitted/);

  const rendered = renderSpoolResult("resume", {
    mode: "resume",
    packet: bounded,
  });
  assert.ok(Buffer.byteLength(rendered, "utf8") <= MAX_TOOL_OUTPUT_BYTES);
  assert.match(rendered, /omitted/);
});

test("multibyte resume fields are byte-truncated with disclosure", () => {
  const packet = largePacket();
  packet.goal.canonicalPath = `/${"💥".repeat(2_000)}`;
  packet.goal.outcome = "ż".repeat(500);
  packet.steps = [
    {
      ...packet.steps[0]!,
      contribution: "💥".repeat(500),
      criteria: "💥".repeat(500),
      checkpoints: [],
    },
  ];
  const bounded = boundResumePacket(packet);
  assert.ok(resumePacketBytes(bounded) <= MAX_RESUME_PACKET_BYTES);
  assert.ok(bounded.omissions.textFields >= 4);
  assert.match(bounded.omissions.notice ?? "", /truncated/);
});

test("a partial completed window does not claim all execution is complete", () => {
  const packet = largePacket();
  packet.steps = [
    {
      ...packet.steps[0]!,
      state: "execution_completed",
      latestAttempt: null,
      checkpoints: [],
    },
  ];
  packet.nextAction = "Execution is complete; reviewed acceptance is not recorded";
  packet.omissions = {
    steps: 1,
    checkpoints: 0,
    textFields: 0,
    notice: null,
  };
  const bounded = boundResumePacket(packet);
  assert.match(bounded.nextAction, /Inspect omitted steps/);
  assert.equal(bounded.acceptance, "not_recorded");
});
