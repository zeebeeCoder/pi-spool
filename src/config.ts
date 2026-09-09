import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SPOOL_CONFIG_FILENAME = "spool.json";

export interface SpoolConfig {
  databaseUrl: string;
  queueName: string;
}

export function getSpoolConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, SPOOL_CONFIG_FILENAME);
}

export function readSpoolConfig(
  env: Record<string, string | undefined> = process.env,
  agentDir: string = getAgentDir(),
): SpoolConfig {
  const databaseOverride = env.SPOOL_DATABASE_URL;
  const queueOverride = env.SPOOL_QUEUE;
  let fileConfig: SpoolConfig | undefined;

  if (databaseOverride === undefined || queueOverride === undefined) {
    fileConfig = readConfigFile(getSpoolConfigPath(agentDir));
  }

  const databaseUrl = databaseOverride ?? fileConfig?.databaseUrl;
  const queueName = queueOverride ?? fileConfig?.queueName;
  validateDatabaseUrl(databaseUrl);
  validateQueueName(queueName);
  return { databaseUrl, queueName };
}

function readConfigFile(path: string): SpoolConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Spool is not configured; create ${path} with databaseUrl and queueName, or set both SPOOL_DATABASE_URL and SPOOL_QUEUE`,
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
    Object.keys(record).some(
      (key) => key !== "databaseUrl" && key !== "queueName",
    ) ||
    typeof record.databaseUrl !== "string" ||
    typeof record.queueName !== "string"
  ) {
    throw invalidFileError(path);
  }
  return {
    databaseUrl: record.databaseUrl,
    queueName: record.queueName,
  };
}

function invalidFileError(path: string): Error {
  return new Error(
    `Invalid Spool config at ${path}; expected only non-empty string keys databaseUrl and queueName`,
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

function validateQueueName(value: string | undefined): asserts value is string {
  if (!value) throw new Error("Spool queueName is required");
  if (!/^[a-z][a-z0-9_]{0,56}$/.test(value)) {
    throw new Error(
      "Spool queueName must be 1-57 lowercase letters, digits, or underscores and start with a letter",
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
