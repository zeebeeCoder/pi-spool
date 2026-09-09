import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SPOOL_CONFIG_FILENAME = "spool.json";

export interface SpoolConfig {
  databaseUrl: string;
}

export function getSpoolConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, SPOOL_CONFIG_FILENAME);
}

/**
 * Reads `<agent dir>/spool.json` unless SPOOL_DATABASE_URL is set.
 * The file may still carry a v1 `queueName` key; it is ignored.
 */
export function readSpoolConfig(
  env: Record<string, string | undefined> = process.env,
  agentDir: string = getAgentDir(),
): SpoolConfig {
  const databaseUrl =
    env.SPOOL_DATABASE_URL ?? readConfigFile(getSpoolConfigPath(agentDir));
  validateDatabaseUrl(databaseUrl);
  return { databaseUrl };
}

function readConfigFile(path: string): string | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Spool is not configured; create ${path} with databaseUrl, or set SPOOL_DATABASE_URL`,
      );
    }
    throw new Error(
      `Unable to read Spool config at ${path}; check that the file exists and is readable`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidFileError(path);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidFileError(path);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "databaseUrl" && key !== "queueName") ||
    typeof record.databaseUrl !== "string"
  ) {
    throw invalidFileError(path);
  }
  return record.databaseUrl;
}

function invalidFileError(path: string): Error {
  return new Error(
    `Invalid Spool config at ${path}; expected a JSON object with a string databaseUrl`,
  );
}

function validateDatabaseUrl(value: string | undefined): asserts value is string {
  if (!value || value.trim() !== value) {
    throw new Error(
      "Spool databaseUrl must be a non-empty PostgreSQL URL without surrounding whitespace",
    );
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("wrong protocol");
    }
  } catch {
    throw new Error(
      "Spool databaseUrl must be a valid postgres:// or postgresql:// URL",
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
