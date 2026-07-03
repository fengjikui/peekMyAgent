import fs from "node:fs";
import path from "node:path";

export function writeFakeNodeCommand(binDir, name, source, { platform = process.platform, nodePath = process.execPath } = {}) {
  const scriptPath = path.join(binDir, `${name}.mjs`);
  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
  if (platform === "win32") {
    fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\n"${nodePath}" "%~dp0${name}.mjs" %*\r\n`);
    return { script_path: scriptPath, command_path: path.join(binDir, `${name}.cmd`) };
  }
  const commandPath = path.join(binDir, name);
  fs.writeFileSync(commandPath, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return { script_path: scriptPath, command_path: commandPath };
}
