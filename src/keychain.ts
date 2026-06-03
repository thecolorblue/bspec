import fs from "fs-extra";
import { configFile, credentialsFile, googleCredentialsFile } from "./paths.js";

type KeytarModule = typeof import("keytar");

const SERVICE = "spec-builder";
let keytarPromise: Promise<KeytarModule | null> | null = null;

async function loadKeytar(): Promise<KeytarModule | null> {
  if (!keytarPromise) {
    keytarPromise = import("keytar")
      .then((mod) => mod.default ?? (mod as unknown as KeytarModule))
      .catch(() => null);
  }
  return keytarPromise;
}

export interface SecretWriteOptions {
  fallbackFile?: "credentials" | "google";
}

export async function setSecret(account: string, secret: string, options: SecretWriteOptions = {}): Promise<{ usedFallback: boolean }> {
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE, account, secret);
    return { usedFallback: false };
  }
  const filePath = resolveFallbackFile(options.fallbackFile);
  await writeFallbackSecret(filePath, account, secret);
  return { usedFallback: true };
}

export async function getSecret(account: string, options: SecretWriteOptions = {}): Promise<string | null> {
  const keytar = await loadKeytar();
  if (keytar) {
    const secret = await keytar.getPassword(SERVICE, account);
    if (secret) {
      return secret;
    }
  }
  const filePath = resolveFallbackFile(options.fallbackFile);
  return readFallbackSecret(filePath, account);
}

export async function deleteSecret(account: string, options: SecretWriteOptions = {}): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE, account);
  }
  const filePath = resolveFallbackFile(options.fallbackFile);
  await removeFallbackSecret(filePath, account);
}

function resolveFallbackFile(option: SecretWriteOptions["fallbackFile"]): string {
  switch (option) {
    case "google":
      return googleCredentialsFile;
    case "credentials":
    default:
      return credentialsFile;
  }
}

async function readFallbackSecret(filePath: string, account: string): Promise<string | null> {
  try {
    const data = await fs.readJson(filePath);
    return typeof data[account]?.value === "string" ? data[account].value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeFallbackSecret(filePath: string, account: string, secret: string): Promise<void> {
  let payload: Record<string, { value: string; updated_at: string }>;
  try {
    payload = await fs.readJson(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      payload = {};
    } else {
      throw error;
    }
  }
  payload[account] = { value: secret, updated_at: new Date().toISOString() };
  await fs.outputJson(filePath, payload, { spaces: 2, mode: 0o600 });
}

async function removeFallbackSecret(filePath: string, account: string): Promise<void> {
  try {
    const data = await fs.readJson(filePath);
    if (data[account]) {
      delete data[account];
      await fs.outputJson(filePath, data, { spaces: 2, mode: 0o600 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    return await fs.readJson(configFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await fs.outputJson(configFile, config, { spaces: 2 });
}
