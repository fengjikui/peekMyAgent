#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOpenCodeDebugConfig } from "../src/adapters/opencode-config.mjs";
import {
  extractHarnessTranslationParts,
  translationMaterialsForRequest,
} from "../src/translation/request-materials.mjs";
import { selectOpenCodeTranslationModel } from "../src/translation/provider-policy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";

const repoRoot = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-opencode-real-"));
const workspace = path.join(tmpDir, "workspace");
const storePath = path.join(tmpDir, "state", "captures.sqlite");
const createdSessionIds = new Set();
const scenarioResults = [];
let beforeSessionIds = new Set();
let sessionBaselineCaptured = false;
let viewer = null;
let primarySessionId = null;
let compactResult = { attempted: false, supported: false };

class ScenarioFailure extends Error {
  constructor(name, code) {
    super(`OpenCode real integration scenario "${name}" failed with exit code ${code}.`);
    this.name = "ScenarioFailure";
    this.scenario = name;
    this.exitCode = code;
  }
}

fs.mkdirSync(path.join(workspace, ".opencode", "skills", "pma-smoke"), { recursive: true });
fs.mkdirSync(path.join(workspace, ".opencode", "commands"), { recursive: true });
fs.writeFileSync(path.join(workspace, "pma-fixture.txt"), "PMA_READ_FIXTURE\n");
fs.writeFileSync(path.join(workspace, "pma-command.txt"), "PMA_COMMAND_FIXTURE\n");
fs.writeFileSync(path.join(workspace, "pma-subagent.txt"), "PMA_SUBAGENT_FIXTURE\n");
fs.writeFileSync(
  path.join(workspace, ".opencode", "skills", "pma-smoke", "SKILL.md"),
  `---
name: pma-smoke
description: A tiny deterministic skill used only by the peekMyAgent OpenCode integration check.
---

When explicitly asked to load this skill, acknowledge the marker PMA_SKILL_LOADED.
Do not inspect unrelated files and do not use shell commands.
`,
);
fs.writeFileSync(
  path.join(workspace, ".opencode", "commands", "pma-smoke.md"),
  `---
description: Exercise OpenCode command expansion for peekMyAgent.
---

Use the read tool exactly once to read pma-command.txt, then answer with PMA_COMMAND_OK.
Do not use bash and do not inspect any other file.
`,
);
spawnSync("git", ["init", "--quiet"], { cwd: workspace, stdio: "ignore" });

const childEnv = {
  ...process.env,
  NO_COLOR: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
};

try {
  assertOpenCodeAvailable();
  const config = runOpenCodeDebugConfig({ cwd: workspace, env: childEnv });
  const model =
    String(process.env.PEEKMYAGENT_OPENCODE_SMOKE_MODEL || "").trim() ||
    selectOpenCodeTranslationModel({ config, env: childEnv }).model;
  beforeSessionIds = await listOpenCodeSessionIds();
  sessionBaselineCaptured = true;
  viewer = await startViewerServer({ cwd: repoRoot, storePath });

  const first = await runScenario({
    name: "ordinary-first-turn",
    watchPolicy: "new",
    model,
    prompt: "Reply with exactly PMA_READY. Do not use any tools.",
    extraArgs: ["--title", "peekMyAgent OpenCode integration"],
  });
  primarySessionId = first.sessionId;
  assert.ok(primarySessionId, "OpenCode JSON events did not expose a session ID");
  createdSessionIds.add(primarySessionId);

  await runScenario({
    name: "ordinary-second-turn",
    watchPolicy: "reuse",
    model,
    sessionId: primarySessionId,
    prompt: "Reply with exactly PMA_SECOND. Do not use any tools.",
  });
  await runScenario({
    name: "read-tool-loop",
    watchPolicy: "reuse",
    model,
    sessionId: primarySessionId,
    prompt:
      "Use the read tool exactly once to read pma-fixture.txt, then answer with exactly PMA_READ_OK. " +
      "Do not use bash or inspect any other file.",
  });
  await runScenario({
    name: "project-skill",
    watchPolicy: "reuse",
    model,
    sessionId: primarySessionId,
    prompt:
      "Use the skill tool exactly once to load pma-smoke, then answer with exactly PMA_SKILL_OK. " +
      "Do not inspect unrelated files.",
  });
  await runScenario({
    name: "custom-command",
    watchPolicy: "reuse",
    model,
    sessionId: primarySessionId,
    prompt: "PMA command integration argument",
    extraArgs: ["--command", "pma-smoke"],
  });
  await runScenario({
    name: "subagent",
    watchPolicy: "reuse",
    model,
    sessionId: primarySessionId,
    prompt:
      "Use the task tool exactly once with an Explore subagent. Ask it to read only pma-subagent.txt " +
      "and return its one-line marker. Then report the marker. Do not do the file task yourself.",
    timeoutMs: 180_000,
  });

  compactResult.attempted = true;
  try {
    await runScenario({
      name: "compact-command",
      watchPolicy: "reuse",
      model,
      sessionId: primarySessionId,
      prompt: "",
      extraArgs: ["--command", "compact"],
      timeoutMs: 180_000,
    });
    compactResult.supported = true;
  } catch (error) {
    compactResult = {
      attempted: true,
      supported: false,
      reason: error instanceof ScenarioFailure ? "command-rejected" : "unexpected-error",
    };
  }

  await waitForSource(primarySessionId);
  const sources = await getJson(`${viewer.url}/api/sources`);
  const source = sources.find(
    (item) =>
      item.agent === "OpenCode" &&
      item.conversation_id === primarySessionId &&
      item.kind === "opencode_proxy_exact",
  );
  assert.ok(source, "The exact OpenCode source was not persisted under the public session ID");
  const view = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(source.id)}`);
  const observedSessionIds = await listOpenCodeSessionIds({ tolerateFailure: true });
  for (const id of observedSessionIds) {
    if (!beforeSessionIds.has(id)) createdSessionIds.add(id);
  }
  const report = validateAndSummarizeView({ view, source, model });
  const previewHoldMs = nonNegativeInteger(process.env.PEEKMYAGENT_OPENCODE_SMOKE_PREVIEW_MS);
  if (previewHoldMs) {
    report.preview = {
      url: `${viewer.url}?source=${encodeURIComponent(source.id)}`,
      hold_ms: previewHoldMs,
    };
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (previewHoldMs) await new Promise((resolve) => setTimeout(resolve, previewHoldMs));
} finally {
  if (sessionBaselineCaptured) {
    const afterSessionIds = await listOpenCodeSessionIds({ tolerateFailure: true });
    for (const id of afterSessionIds) {
      if (!beforeSessionIds.has(id)) createdSessionIds.add(id);
    }
  }
  const cleanup = [];
  for (const id of createdSessionIds) {
    cleanup.push(await deleteOpenCodeSession(id));
  }
  await viewer?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const failedCleanup = cleanup.filter((item) => !item.deleted);
  if (failedCleanup.length) {
    process.stderr.write(
      `OpenCode real integration cleanup warning: ${failedCleanup.length} temporary session(s) could not be deleted.\n`,
    );
  }
}

async function runScenario({
  name,
  watchPolicy,
  model,
  sessionId = null,
  prompt,
  extraArgs = [],
  timeoutMs = 120_000,
}) {
  const childArgs = [
    "run",
    "opencode",
    "--watch",
    watchPolicy,
    "--viewer-url",
    viewer.url,
    "--",
    "run",
    "--pure",
    "--format",
    "json",
    "--auto",
    "--dir",
    workspace,
    "--model",
    model,
    ...extraArgs,
  ];
  if (sessionId) childArgs.push("--session", sessionId);
  if (prompt) childArgs.push(prompt);

  const result = await runProcess(process.execPath, ["bin/peekmyagent.mjs", ...childArgs], {
    cwd: repoRoot,
    env: childEnv,
    timeoutMs,
  });
  if (result.code !== 0) throw new ScenarioFailure(name, result.code);
  const events = parseJsonLines(result.stdout);
  const observedSessionId = findSessionId(events) || sessionId;
  if (observedSessionId) createdSessionIds.add(observedSessionId);
  scenarioResults.push({
    name,
    event_count: events.length,
    event_types: uniqueStrings(events.flatMap(eventTypeCandidates)),
    session_reused: Boolean(sessionId && observedSessionId === sessionId),
  });
  return { sessionId: observedSessionId, events };
}

function validateAndSummarizeView({ view, source, model }) {
  assert.equal(view.source.agent, "OpenCode");
  assert.equal(view.source.kind, "opencode_proxy_exact");
  assert.equal(view.source.conversation_id, primarySessionId);
  assert.ok(view.requests.length >= 6, "Expected multiple real OpenCode model requests");

  const requestIndexes = view.requests.map((request) => request.request_index);
  assert.deepEqual(
    requestIndexes,
    Array.from({ length: requestIndexes.length }, (_, index) => index + 1),
    "OpenCode request indexes must remain contiguous",
  );

  const mainRequests = view.requests.filter((request) => request.source_hint?.type !== "metadata");
  const roleShapes = uniqueStrings(
    mainRequests.map((request) =>
      (request.raw?.body?.messages || request.raw?.body?.input || [])
        .map((message) => String(message?.role || message?.type || "unknown"))
        .join(","),
    ),
  );
  const toolCalls = mainRequests.flatMap((request) => request.summary?.response?.tool_calls || []);
  const toolResults = mainRequests.flatMap((request) => request.summary?.current_tool_results || []);
  const toolCallNames = uniqueStrings(toolCalls.map((call) => call?.name));
  const ordinarySecondRequest = mainRequests.find((request) =>
    String(request.summary?.current_user || "").includes("PMA_SECOND"),
  );
  assert.ok(ordinarySecondRequest, "The second ordinary turn was not preserved as the current user input");
  assert.equal(
    ordinarySecondRequest.summary?.current_tool_calls?.length || 0,
    0,
    "A system-prompt variation must not replay historical tool calls into an ordinary turn",
  );
  assert.equal(
    ordinarySecondRequest.summary?.current_tool_results?.length || 0,
    0,
    "A system-prompt variation must not replay historical tool results into an ordinary turn",
  );
  assert.ok(toolCallNames.includes("read"), "The real read-tool scenario did not produce a read call");
  assert.ok(toolCallNames.includes("skill"), "The real Skill scenario did not produce a skill call");
  assert.ok(
    toolCallNames.some((name) => ["task", "Task"].includes(name)),
    "The real subagent scenario did not produce a task call",
  );
  assert.ok(toolResults.length >= 3, "Expected real tool results to return upstream");

  const commandRequest = mainRequests.find(
    (request) => request.raw?.headers?.["x-peek-opencode-command"] === "pma-smoke",
  );
  assert.ok(commandRequest, "The custom command request lost its local command evidence");
  const commandHarness = translationMaterialsForRequest(commandRequest, {
    section: "harness",
    extractHarnessParts: extractHarnessTranslationParts,
  });
  assert.ok(
    commandHarness.some((item) => item.kind === "harness_command"),
    "The custom command expansion was not projected into Harness materials",
  );
  assert.ok(
    (commandRequest.raw?.body?.messages || []).some((message) => message.role === "user"),
    "The command-expanded message must remain present in History/Message evidence",
  );

  const sourceHints = countBy(
    view.requests.map((request) => request.source_hint?.type || "main"),
  );
  const requestToolNames = uniqueStrings(
    mainRequests.flatMap((request) =>
      (request.raw?.body?.tools || []).map(
        (tool) => tool?.function?.name || tool?.name || tool?.custom?.name || "unknown",
      ),
    ),
  );
  const graph = view.agent_trace || null;

  return {
    kind: "opencode_real_integration",
    opencode_version: openCodeVersion(),
    model,
    workspace_is_temporary: true,
    scenarios: scenarioResults,
    capture: {
      source_kind: source.kind,
      request_count: view.requests.length,
      main_request_count: mainRequests.length,
      request_indexes_contiguous: true,
      source_hints: sourceHints,
      upstream_role_shapes: roleShapes,
      advertised_tool_names: requestToolNames,
      observed_tool_calls: toolCallNames,
      observed_tool_result_count: toolResults.length,
      ordinary_turn_delta_clean: true,
      command_harness_projection: true,
      command_original_message_retained: true,
      subagent_graph: graph
        ? {
            branch_count: graph.branch_count || 0,
            spawn_count: graph.spawn_count || 0,
            return_count: graph.return_count || 0,
            confidence: graph.confidence || "none",
          }
        : null,
      compact: compactResult,
    },
    privacy: {
      prompts_printed: false,
      responses_printed: false,
      credentials_read_by_script: false,
      user_config_modified: false,
    },
    cleanup: {
      temporary_project: "remove-on-exit",
      temporary_store: "remove-on-exit",
      new_opencode_sessions: createdSessionIds.size,
      session_policy: "delete-on-exit",
    },
  };
}

function assertOpenCodeAvailable() {
  const result = spawnSync("opencode", ["--version"], {
    cwd: workspace,
    env: childEnv,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error("OpenCode is not available. Install and configure OpenCode before running this manual check.");
  }
}

function openCodeVersion() {
  const result = spawnSync("opencode", ["--version"], {
    cwd: workspace,
    env: childEnv,
    encoding: "utf8",
  });
  return result.status === 0 ? String(result.stdout || "").trim() : "unknown";
}

async function listOpenCodeSessionIds({ tolerateFailure = false } = {}) {
  const result = await runProcess(
    "opencode",
    ["session", "list", "--format", "json", "-n", "500"],
    { cwd: workspace, env: childEnv, timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    if (tolerateFailure) return new Set();
    throw new Error("Could not list OpenCode sessions before the real integration check.");
  }
  return new Set(collectSessionIds(parseJsonDocumentOrLines(result.stdout)));
}

async function deleteOpenCodeSession(id) {
  const result = await runProcess("opencode", ["session", "delete", id], {
    cwd: workspace,
    env: childEnv,
    timeoutMs: 30_000,
  });
  return { id, deleted: result.code === 0 };
}

async function waitForSource(sessionId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const sources = await getJson(`${viewer.url}/api/sources`);
    const source = sources.find(
      (item) =>
        item.agent === "OpenCode" &&
        item.conversation_id === sessionId &&
        item.kind === "opencode_proxy_exact" &&
        item.live_status === "stopped",
    );
    if (source) return source;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the OpenCode source to finish persisting.");
}

function parseJsonLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function parseJsonDocumentOrLines(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    return parseJsonLines(text);
  }
}

function collectSessionIds(value) {
  const ids = [];
  walk(value, (key, candidate) => {
    if (!["id", "sessionID", "sessionId", "session_id"].includes(key)) return;
    const id = String(candidate || "").trim();
    if (/^ses_[A-Za-z0-9_-]+$/.test(id)) ids.push(id);
  });
  return uniqueStrings(ids);
}

function findSessionId(events) {
  const ids = [];
  walk(events, (key, candidate) => {
    if (!["sessionID", "sessionId", "session_id"].includes(key)) return;
    const id = String(candidate || "").trim();
    if (id) ids.push(id);
  });
  return ids[0] || null;
}

function eventTypeCandidates(event) {
  return uniqueStrings([
    event?.type,
    event?.event,
    event?.part?.type,
    event?.data?.type,
    event?.properties?.type,
  ]);
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walk(child, visit);
  }
}

function countBy(values) {
  const output = {};
  for (const value of values) output[value] = (output[value] || 0) + 1;
  return output;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Process timed out: ${command} (${signal || "terminated"})`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
