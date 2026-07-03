import fs from "node:fs";
import path from "node:path";
import { runOpenClawConfig } from "../../src/adapters/openclaw-config.mjs";
import { expandHomePath, joinPlatformPath, userHome } from "../../src/core/platform.mjs";

export function removeOpenClawProfileDir(profile, { env = process.env, platform = process.platform } = {}) {
  const candidates = [];
  try {
    const configPath = expandHomePath(runOpenClawConfig(["config", "file"], { profile, env }), { env, platform });
    if (configPath) candidates.push(path.dirname(configPath));
  } catch {
    // OpenClaw may already be unavailable during cleanup; fall back to the legacy profile directory shape.
  }
  const home = userHome({ env, platform });
  if (home) candidates.push(joinPlatformPath(platform, home, `.openclaw-${profile}`));

  const removed = [];
  for (const dir of unique(candidates)) {
    if (!dir || !fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
