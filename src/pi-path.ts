import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";

function resolveFromModule(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(moduleDir, "..", "node_modules", ".bin", isWindows ? "pi.cmd" : "pi");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(moduleDir, "..", "..", "node_modules", ".bin", isWindows ? "pi.cmd" : "pi");
}

export function resolvePiBinary(): string {
  const local = path.resolve(process.cwd(), "node_modules", ".bin", isWindows ? "pi.cmd" : "pi");
  if (fs.existsSync(local)) {
    return local;
  }
  const moduleScoped = resolveFromModule();
  if (fs.existsSync(moduleScoped)) {
    return moduleScoped;
  }
  return isWindows ? "pi.cmd" : "pi";
}
