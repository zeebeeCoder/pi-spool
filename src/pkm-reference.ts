import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const MAX_PKM_TASK_BYTES = 64 * 1024;
export const MAX_PKM_GOAL_CHARS = 2_000;
export const MAX_PKM_TITLE_CHARS = 300;
export const MAX_PKM_PROJECT_CHARS = 200;

export type PkmReferenceStatus =
  | "available"
  | "missing"
  | "mismatch"
  | "malformed"
  | "oversized"
  | "invalid_path"
  | "unreadable";

export interface PkmTaskReference {
  status: PkmReferenceStatus;
  canonicalPath: string;
  expectedTaskId: string;
  fileTaskId: string | null;
  title: string | null;
  project: string | null;
  goalText: string | null;
  notice: string;
}

export interface PkmReferenceReaderLike {
  read(
    canonicalPath: string,
    expectedTaskId: string,
    signal?: AbortSignal,
  ): Promise<PkmTaskReference>;
}

export class PkmReferenceReader implements PkmReferenceReaderLike {
  async read(
    canonicalPath: string,
    expectedTaskId: string,
    signal?: AbortSignal,
  ): Promise<PkmTaskReference> {
    throwIfAborted(signal);
    if (!isAbsolute(canonicalPath)) {
      return unavailable(
        "invalid_path",
        canonicalPath,
        expectedTaskId,
        "Recorded canonical path is not absolute; PKM attribution was not read",
      );
    }

    let handle;
    try {
      handle = await open(canonicalPath, "r");
      throwIfAborted(signal);
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return unavailable(
          "unreadable",
          canonicalPath,
          expectedTaskId,
          "Recorded canonical path is not a regular file",
        );
      }
      if (stats.size > MAX_PKM_TASK_BYTES) {
        return unavailable(
          "oversized",
          canonicalPath,
          expectedTaskId,
          `PKM task exceeds the ${MAX_PKM_TASK_BYTES}-byte attribution limit`,
        );
      }
      const buffer = Buffer.alloc(MAX_PKM_TASK_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        throwIfAborted(signal);
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_PKM_TASK_BYTES) {
        return unavailable(
          "oversized",
          canonicalPath,
          expectedTaskId,
          `PKM task exceeds the ${MAX_PKM_TASK_BYTES}-byte attribution limit`,
        );
      }
      return parsePkmTaskReference(
        buffer.subarray(0, offset).toString("utf8"),
        canonicalPath,
        expectedTaskId,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = errorCode(error);
      if (code === "ENOENT") {
        return unavailable(
          "missing",
          canonicalPath,
          expectedTaskId,
          "Recorded PKM task file is missing",
        );
      }
      return unavailable(
        "unreadable",
        canonicalPath,
        expectedTaskId,
        "Recorded PKM task file could not be read",
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export function parsePkmTaskReference(
  content: string,
  canonicalPath: string,
  expectedTaskId: string,
): PkmTaskReference {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(content);
  } catch {
    return unavailable(
      "malformed",
      canonicalPath,
      expectedTaskId,
      "PKM frontmatter is malformed",
    );
  }
  const fileTaskId = boundedString(parsed.frontmatter.id, 100);
  const title =
    boundedString(parsed.frontmatter.title, MAX_PKM_TITLE_CHARS) ??
    firstHeading(parsed.body, MAX_PKM_TITLE_CHARS);
  const project = boundedString(
    parsed.frontmatter.project,
    MAX_PKM_PROJECT_CHARS,
  );
  if (fileTaskId !== expectedTaskId) {
    return {
      status: "mismatch",
      canonicalPath,
      expectedTaskId,
      fileTaskId,
      title: null,
      project: null,
      goalText: null,
      notice: fileTaskId
        ? `PKM task ID ${fileTaskId} does not match recorded ${expectedTaskId}`
        : `PKM task ID is missing; expected ${expectedTaskId}`,
    };
  }
  return {
    status: "available",
    canonicalPath,
    expectedTaskId,
    fileTaskId,
    title,
    project,
    goalText: extractGoalSection(parsed.body),
    notice: "PKM attribution verified against the recorded task ID",
  };
}

export function extractGoalSection(body: string): string | null {
  const lines = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const start = lines.findIndex((line) => /^##\s+Goal\s*$/i.test(line.trim()));
  if (start < 0) return null;
  const selected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^#{1,2}\s+/.test(line.trim())) break;
    selected.push(line);
  }
  const goal = selected.join("\n").trim();
  if (!goal) return null;
  return goal.length <= MAX_PKM_GOAL_CHARS
    ? goal
    : `${goal.slice(0, MAX_PKM_GOAL_CHARS)}\n\n[Goal text truncated at ${MAX_PKM_GOAL_CHARS} characters]`;
}

function firstHeading(body: string, limit: number): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? fit(match[1]!.trim(), limit) : null;
}

function boundedString(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim()
    ? fit(value.trim(), limit)
    : null;
}

function fit(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function unavailable(
  status: Exclude<PkmReferenceStatus, "available" | "mismatch">,
  canonicalPath: string,
  expectedTaskId: string,
  notice: string,
): PkmTaskReference {
  return {
    status,
    canonicalPath,
    expectedTaskId,
    fileTaskId: null,
    title: null,
    project: null,
    goalText: null,
    notice,
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("PKM read cancelled");
}
