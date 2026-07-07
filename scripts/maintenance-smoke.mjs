import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openPersistenceStore } from "../src/core/persistence-store.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-maintenance-"));
const fakeHome = path.join(tmpDir, "home");
const projectDir = path.join(tmpDir, "project with spaces");
const stateDir = path.join(tmpDir, "state");
const registryPath = path.join(stateDir, "viewer.json");
const ideRegistryPath = path.join(stateDir, "ide-integrations.json");
const translationsDir = path.join(stateDir, "translations");
const externalStoreDir = path.join(tmpDir, "external-store");
const externalStorePath = path.join(externalStoreDir, "custom.sqlite");
const apiPort = await freePort();
const capturePort = await freePort();

try {
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    PEEKMYAGENT_STATE_DIR: stateDir,
    PEEKMYAGENT_VIEWER_REGISTRY_PATH: registryPath,
    PEEKMYAGENT_IDE_REGISTRY_PATH: ideRegistryPath,
    PEEKMYAGENT_DAEMON_PORT: String(apiPort),
    PEEKMYAGENT_CAPTURE_PORT: String(capturePort),
  };

  fs.writeFileSync(path.join(stateDir, "store.sqlite"), "store");
  fs.writeFileSync(path.join(stateDir, "store.sqlite-wal"), "wal");
  fs.writeFileSync(path.join(stateDir, "store.sqlite-shm"), "shm");
  const clearResult = runCli(["clear", "--all-sessions", "--json"], env);
  assert.equal(clearResult.status, 0, clearResult.stderr);
  const clear = JSON.parse(clearResult.stdout);
  assert.equal(clear.action, "clear");
  assert.deepEqual(clear.deleted.map((item) => path.basename(item)).sort(), ["store.sqlite", "store.sqlite-shm", "store.sqlite-wal"]);
  assert.equal(fs.existsSync(path.join(stateDir, "store.sqlite")), false);
  assert.equal(fs.existsSync(stateDir), true);

  fs.mkdirSync(externalStoreDir, { recursive: true });
  const directoryStoreEnv = {
    ...env,
    PEEKMYAGENT_STORE_PATH: externalStoreDir,
  };
  const clearDirectoryStoreResult = runCli(["clear", "--all-sessions", "--json"], directoryStoreEnv);
  assert.equal(clearDirectoryStoreResult.status, 1);
  assert.match(clearDirectoryStoreResult.stderr, /Refusing to remove directory as file-backed peekMyAgent data/);
  assert.equal(fs.existsSync(externalStoreDir), true, "clear must not recursively delete a directory-shaped store path");

  const uninstallDirectoryStoreResult = runCli(["uninstall", "--scope", "user", "--remove-data", "--keep-cli", "--json"], directoryStoreEnv);
  assert.equal(uninstallDirectoryStoreResult.status, 1);
  assert.match(uninstallDirectoryStoreResult.stderr, /Refusing to remove directory as file-backed peekMyAgent data/);
  assert.equal(fs.existsSync(externalStoreDir), true, "uninstall --remove-data must not recursively delete a directory-shaped store path");

  const compactStorePath = path.join(externalStoreDir, "compact.sqlite");
  const compactEnv = {
    ...env,
    PEEKMYAGENT_STORE_PATH: compactStorePath,
  };
  seedCompactableStore(compactStorePath);
  const compactResult = runCli(["compact", "--no-vacuum", "--json"], compactEnv);
  assert.equal(compactResult.status, 0, compactResult.stderr);
  const compact = JSON.parse(compactResult.stdout);
  assert.equal(compact.action, "compact");
  assert.equal(compact.compacted, 1);
  assert.ok(compact.cleared_raw_body_json_bytes > 0);
  const compactedStore = openPersistenceStore(compactStorePath);
  try {
    assert.equal(compactedStore.storageStats().stored_raw_body_json_bytes, 0, "compact CLI removes duplicate raw_body_json");
    assert.equal(compactedStore.reconstructBody("compact-capture").messages[0].content, "compact me");
  } finally {
    compactedStore.close();
  }

  fs.writeFileSync(externalStorePath, "store");
  fs.writeFileSync(`${externalStorePath}-wal`, "wal");
  fs.writeFileSync(`${externalStorePath}-shm`, "shm");
  const externalEnv = {
    ...env,
    PEEKMYAGENT_STORE_PATH: externalStorePath,
  };
  const clearExternalResult = runCli(["clear", "--all-sessions", "--json"], externalEnv);
  assert.equal(clearExternalResult.status, 0, clearExternalResult.stderr);
  const clearExternal = JSON.parse(clearExternalResult.stdout);
  assert.equal(clearExternal.store_path, externalStorePath);
  assert.deepEqual(clearExternal.deleted.map((item) => path.basename(item)).sort(), ["custom.sqlite", "custom.sqlite-shm", "custom.sqlite-wal"]);
  assert.equal(fs.existsSync(externalStorePath), false);

  const installResult = runCli(["install-claude-skill", "--commands", "--json"], env);
  assert.equal(installResult.status, 0, installResult.stderr);
  const installed = JSON.parse(installResult.stdout);
  assert.ok(fs.existsSync(installed.skill_path));
  assert.ok(installed.command_paths.every((filePath) => fs.existsSync(filePath)));

  fs.writeFileSync(path.join(stateDir, "marker.txt"), "keep");
  const uninstallKeepResult = runCli(["uninstall", "--scope", "user", "--keep-data", "--keep-cli", "--json"], env);
  assert.equal(uninstallKeepResult.status, 0, uninstallKeepResult.stderr);
  const uninstallKeep = JSON.parse(uninstallKeepResult.stdout);
  assert.equal(uninstallKeep.action, "uninstall");
  assert.equal(uninstallKeep.data, "kept");
  assert.equal(fs.existsSync(installed.skill_path), false);
  assert.equal(fs.existsSync(path.join(stateDir, "marker.txt")), true);

  const reinstallUserResult = runCli(["install-claude-skill", "--commands", "--json"], env);
  assert.equal(reinstallUserResult.status, 0, reinstallUserResult.stderr);
  const reinstalledUser = JSON.parse(reinstallUserResult.stdout);
  assert.ok(fs.existsSync(reinstalledUser.skill_path));

  const installProjectResult = runCli(["install-claude-skill", "--scope", "project", "--commands", "--json"], env, projectDir);
  assert.equal(installProjectResult.status, 0, installProjectResult.stderr);
  const installedProject = JSON.parse(installProjectResult.stdout);
  assert.equal(installedProject.scope, "project");
  assert.ok(fs.realpathSync(installedProject.skill_path).startsWith(fs.realpathSync(path.join(projectDir, ".claude"))));
  assert.ok(fs.existsSync(installedProject.skill_path));
  assert.ok(installedProject.command_paths.every((filePath) => fs.existsSync(filePath)));

  const uninstallAllResult = runCli(["uninstall", "--scope", "all", "--keep-data", "--keep-cli", "--json"], env, projectDir);
  assert.equal(uninstallAllResult.status, 0, uninstallAllResult.stderr);
  const uninstallAll = JSON.parse(uninstallAllResult.stdout);
  assert.equal(uninstallAll.scope, "all");
  assert.equal(uninstallAll.data, "kept");
  assert.ok(uninstallAll.removed_helpers.some((item) => item.scope === "user" && samePathText(item.path, path.dirname(reinstalledUser.skill_path))));
  assert.ok(uninstallAll.removed_helpers.some((item) => item.scope === "project" && samePathText(item.path, path.dirname(installedProject.skill_path))));
  assert.equal(fs.existsSync(reinstalledUser.skill_path), false);
  assert.equal(fs.existsSync(installedProject.skill_path), false);
  assert.equal(fs.existsSync(path.join(stateDir, "marker.txt")), true);

  const invalidScopeResult = runCli(["uninstall", "--scope", "workspace", "--keep-data", "--keep-cli", "--json"], env);
  assert.equal(invalidScopeResult.status, 1);
  assert.match(invalidScopeResult.stderr, /Invalid --scope: workspace/);

  fs.writeFileSync(externalStorePath, "store");
  fs.writeFileSync(`${externalStorePath}-wal`, "wal");
  fs.writeFileSync(`${externalStorePath}-shm`, "shm");
  const uninstallExternalResult = runCli(["uninstall", "--scope", "user", "--remove-data", "--keep-cli", "--json"], externalEnv);
  assert.equal(uninstallExternalResult.status, 0, uninstallExternalResult.stderr);
  const uninstallExternal = JSON.parse(uninstallExternalResult.stdout);
  assert.equal(uninstallExternal.data, "removed");
  assert.equal(fs.existsSync(externalStorePath), false);
  assert.equal(fs.existsSync(`${externalStorePath}-wal`), false);
  assert.equal(fs.existsSync(`${externalStorePath}-shm`), false);
  assert.equal(fs.existsSync(externalStoreDir), true);
  assert.equal(fs.existsSync(path.join(stateDir, "marker.txt")), true);

  fs.writeFileSync(path.join(stateDir, "store.sqlite"), "store");
  fs.writeFileSync(path.join(stateDir, "store.sqlite-wal"), "wal");
  fs.writeFileSync(path.join(stateDir, "store.sqlite-shm"), "shm");
  fs.writeFileSync(registryPath, "{}");
  fs.writeFileSync(ideRegistryPath, "{}");
  fs.mkdirSync(translationsDir, { recursive: true });
  fs.writeFileSync(path.join(translationsDir, "material.jsonl"), "{}\n");
  const uninstallRemoveResult = runCli(["uninstall", "--scope", "user", "--remove-data", "--keep-cli", "--json"], env);
  assert.equal(uninstallRemoveResult.status, 0, uninstallRemoveResult.stderr);
  const uninstallRemove = JSON.parse(uninstallRemoveResult.stdout);
  assert.equal(uninstallRemove.data, "removed");
  assert.equal(uninstallRemove.state_dir_removed, false);
  assert.equal(fs.existsSync(path.join(stateDir, "store.sqlite")), false);
  assert.equal(fs.existsSync(registryPath), false);
  assert.equal(fs.existsSync(ideRegistryPath), false);
  assert.equal(fs.existsSync(translationsDir), false);
  assert.equal(fs.existsSync(path.join(stateDir, "marker.txt")), true);

  fs.rmSync(path.join(stateDir, "marker.txt"));
  const uninstallEmptyResult = runCli(["uninstall", "--scope", "user", "--remove-data", "--keep-cli", "--json"], env);
  assert.equal(uninstallEmptyResult.status, 0, uninstallEmptyResult.stderr);
  const uninstallEmpty = JSON.parse(uninstallEmptyResult.stdout);
  assert.equal(uninstallEmpty.state_dir_removed, true);
  assert.equal(fs.existsSync(stateDir), false);

  console.log("maintenance smoke passed");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env, workdir = cwd) {
  return spawnSync(process.execPath, [path.join(cwd, "bin", "peekmyagent.mjs"), ...args], {
    cwd: workdir,
    env,
    encoding: "utf8",
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function samePathText(left, right) {
  return normalizePathText(left) === normalizePathText(right);
}

function normalizePathText(value) {
  return path.resolve(String(value)).replace(/^\/private\/var\//, "/var/");
}

function seedCompactableStore(storePath) {
  const store = openPersistenceStore(storePath);
  const body = {
    model: "mock",
    messages: [{ role: "user", content: "compact me" }],
    tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }],
  };
  try {
    store.upsertCapture({
      watch: { watch_id: "compact-watch", label: "Compact smoke", agent: "Claude Code", status: "stored" },
      capture: {
        capture_id: "compact-capture",
        watch_id: "compact-watch",
        request_index: 1,
        received_at: "2026-07-07T00:00:00.000Z",
        method: "POST",
        path: "/v1/messages",
        body,
        raw_body_length: Buffer.byteLength(JSON.stringify(body)),
      },
    });
    store.db
      .prepare("UPDATE model_requests SET raw_body_json = ?, body_source = 'original' WHERE request_id = ?")
      .run(JSON.stringify(body), "compact-capture");
    assert.ok(store.storageStats().stored_raw_body_json_bytes > 0, "seed store should contain duplicate raw_body_json");
  } finally {
    store.close();
  }
}
