import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const ENV_HOME = "SPEC_BUILDER_HOME";

function resolveHomeDir(): string {
  const override = process.env[ENV_HOME];
  if (override && override.trim()) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".spec-builder");
}

export const homeDir = resolveHomeDir();
export const logsDir = path.join(homeDir, "logs");
export const configFile = path.join(homeDir, "config.json");
export const credentialsFile = path.join(homeDir, "credentials.json");
export const googleCredentialsFile = path.join(homeDir, "google-credentials.json");

export function sessionDir(sessionId: string): string {
  return path.join(logsDir, sessionId);
}

export async function ensureBaseDirs(): Promise<void> {
  await fs.ensureDir(homeDir);
  await fs.ensureDir(logsDir);
}

export async function ensureSessionDir(sessionId: string): Promise<string> {
  const dir = sessionDir(sessionId);
  await fs.ensureDir(dir);
  return dir;
}
