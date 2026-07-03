import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";
import { removeOpenClawProfileDir } from "./lib/openclaw-profile-cleanup.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-openclaw-cleanup-"));
const binDir = path.join(tmpDir, "bin");
const home = path.join(tmpDir, "home");
const profile = "peek-cleanup";
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(home, { recursive: true });

try {
  const profileDir = path.join(home, "profiles", profile);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "openclaw.json"), "{}");
  writeFakeNodeCommand(
    binDir,
    "openclaw",
    `
const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = profileIndex === -1 ? "default" : args[profileIndex + 1];
if (args.includes("config") && args.includes("file")) {
  console.log("Config warnings:");
  console.log("~/profiles/" + profile + "/openclaw.json");
  process.exit(0);
}
process.exit(2);
`,
  );

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
  };
  const removed = removeOpenClawProfileDir(profile, { env });
  assert.deepEqual(removed, [profileDir]);
  assert.equal(fs.existsSync(profileDir), false);

  const fallbackDir = path.join(home, `.openclaw-${profile}`);
  fs.mkdirSync(fallbackDir, { recursive: true });
  const fallbackRemoved = removeOpenClawProfileDir(profile, { env: { ...env, PATH: "" } });
  assert.deepEqual(fallbackRemoved, [fallbackDir]);
  assert.equal(fs.existsSync(fallbackDir), false);

  console.log("openclaw profile cleanup smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
