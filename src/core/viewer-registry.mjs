import fs from "node:fs";
import path from "node:path";
import { defaultStateDir, viewerRegistryPath as resolveViewerRegistryPath } from "./app-paths.mjs";

export function viewerRegistryPath() {
  return resolveViewerRegistryPath();
}

export function writeViewerRegistry(entry) {
  fs.mkdirSync(defaultStateDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    viewerRegistryPath(),
    `${JSON.stringify(
      {
        ...entry,
        pid: process.pid,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export function readViewerRegistry() {
  try {
    return JSON.parse(fs.readFileSync(viewerRegistryPath(), "utf8"));
  } catch {
    return null;
  }
}

export function clearViewerRegistry(expectedUrl) {
  const current = readViewerRegistry();
  if (expectedUrl && current?.url !== expectedUrl) return;
  try {
    fs.rmSync(viewerRegistryPath());
  } catch {
    // Ignore missing/stale registry files.
  }
}
