import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const SPOOL_BINDING_ENTRY = "spool-binding";

export interface SessionBinding {
  version: 1;
  workId: string;
  vault: string;
  taskId: string;
  canonicalPath: string;
  stepId?: string;
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

export function restoreBinding(entries: readonly SessionEntryLike[]): SessionBinding | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== SPOOL_BINDING_ENTRY) {
      continue;
    }
    return isSessionBinding(entry.data) ? entry.data : null;
  }
  return null;
}

export function isSessionBinding(value: unknown): value is SessionBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<SessionBinding>;
  return (
    binding.version === 1 &&
    isNonEmpty(binding.workId) &&
    isNonEmpty(binding.vault) &&
    isNonEmpty(binding.taskId) &&
    isNonEmpty(binding.canonicalPath) &&
    (binding.stepId === undefined || isNonEmpty(binding.stepId))
  );
}

export async function validateCanonicalTaskReference(input: {
  vault: string;
  taskId: string;
  canonicalPath: string;
}): Promise<{ vault: string; taskId: string; canonicalPath: string }> {
  if (!isAbsolute(input.canonicalPath)) {
    throw new Error("canonicalPath must be absolute");
  }
  const canonicalPath = resolve(input.canonicalPath);
  const content = await readFile(canonicalPath, "utf8");
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!frontmatter) {
    throw new Error("canonical task file must start with YAML frontmatter");
  }
  const id = frontmatter[1]?.match(/^id:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  if (id !== input.taskId) {
    throw new Error(
      `canonical task ID mismatch: expected ${input.taskId}, found ${id ?? "none"}`,
    );
  }
  return { ...input, canonicalPath };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
