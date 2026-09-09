import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export const SPOOL_BINDING_ENTRY = "spool-binding";

export interface SessionBinding {
  version: 1;
  workId: string;
  vault: string;
  taskId: string;
  canonicalPath: string;
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Restores the latest binding stored on the current session branch. */
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
    isNonEmpty(binding.canonicalPath)
  );
}

export interface CanonicalTaskReference {
  vault: string;
  taskId: string;
  canonicalPath: string;
  title: string | null;
}

/**
 * Reads a PKM task file and derives the goal reference from it: the task ID
 * comes from frontmatter `id`, the vault from an explicit argument or the
 * `vaults/<name>/` path segment, and the title from frontmatter `title`.
 */
export async function readCanonicalTaskReference(input: {
  canonicalPath: string;
  vault?: string;
}): Promise<CanonicalTaskReference> {
  if (!isAbsolute(input.canonicalPath)) {
    throw new Error("canonicalPath must be absolute");
  }
  const canonicalPath = resolve(input.canonicalPath);
  const content = await readFile(canonicalPath, "utf8");
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (!frontmatter) {
    throw new Error("canonical task file must start with YAML frontmatter");
  }
  const taskId = frontmatter[1]?.match(/^id:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  if (!taskId) {
    throw new Error("canonical task frontmatter has no id");
  }
  const title = frontmatter[1]?.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? null;
  const vault = input.vault ?? vaultFromPath(canonicalPath);
  if (!vault) {
    throw new Error(
      "vault could not be derived from the path; pass vault explicitly",
    );
  }
  return { vault, taskId, canonicalPath, title };
}

export function vaultFromPath(path: string): string | null {
  const parts = path.split(sep);
  const index = parts.lastIndexOf("vaults");
  const vault = index >= 0 ? parts[index + 1] : undefined;
  return vault && vault.length > 0 ? vault : null;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
