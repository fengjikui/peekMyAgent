import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readBody } from "../src/core/capture-proxy.mjs";
import { startViewerServer } from "../src/viewer/server.mjs";
import { writeFakeNodeCommand } from "./lib/fake-node-command.mjs";

const cwd = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-observe-wrapper-"));
const binDir = path.join(tmpDir, "bin");
const childStatePath = path.join(tmpDir, "child-state.json");
const storePath = path.join(tmpDir, "store.sqlite");
const previousStateDir = process.env.PEEKMYAGENT_STATE_DIR;
process.env.PEEKMYAGENT_STATE_DIR = path.join(tmpDir, "state");
fs.mkdirSync(binDir, { recursive: true });
const wireRequests = [];

const upstream = http.createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || "{}");
  wireRequests.push({
    path: req.url,
    authorization: req.headers.authorization || null,
    apiKey: req.headers["x-api-key"] || null,
    body,
  });
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/v1/responses") {
    res.end(JSON.stringify({
      id: "resp_observe_openai",
      object: "response",
      status: "completed",
      model: "observe-openai-model",
      output: [{
        id: "msg_observe_openai",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OpenAI observe response", annotations: [] }],
      }],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    }));
    return;
  }
  if (req.url === "/v1/messages") {
    res.end(JSON.stringify({
      id: "msg_observe_anthropic",
      type: "message",
      role: "assistant",
      model: "observe-anthropic-model",
      content: [{ type: "text", text: "Anthropic observe response" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "unexpected path" }));
});

const upstreamUrl = await listen(upstream);
const viewer = await startViewerServer({ cwd, storePath });

try {
  writeFakeNodeCommand(
    binDir,
    "my-agent",
    `
import fs from 'node:fs';

const protocol = process.env.PEEK_FAKE_OBSERVE_PROTOCOL;
const envName = protocol === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL';
const baseUrl = process.env[envName] || '';
const expectedKey = protocol === 'openai' ? 'openai-observe-secret' : 'anthropic-observe-secret';
fs.writeFileSync(process.env.PEEK_FAKE_OBSERVE_STATE_PATH, JSON.stringify({
  protocol,
  baseUrlOverridden: baseUrl !== process.env.PEEK_FAKE_OBSERVE_ORIGINAL_BASE_URL,
  keyPreserved: process.env[protocol === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'] === expectedKey,
  args: process.argv.slice(2),
}, null, 2));

if (process.env.PEEK_FAKE_OBSERVE_FAIL === '1') {
  console.error('fake observed harness failed');
  process.exit(17);
}

const response = await fetch(baseUrl.replace(/\\/$/, '') + (protocol === 'openai' ? '/responses' : '/v1/messages'), {
  method: 'POST',
  headers: protocol === 'openai'
    ? { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY }
    : { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(protocol === 'openai'
    ? {
        model: 'observe-openai-model',
        instructions: 'Observe the custom harness.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'OpenAI observe request' }] }],
        temperature: 0.2,
      }
    : {
        model: 'observe-anthropic-model',
        system: 'Observe the custom harness.',
        messages: [{ role: 'user', content: 'Anthropic observe request' }],
        temperature: 0.3,
        max_tokens: 128,
      }),
});
if (!response.ok) {
  console.error(await response.text());
  process.exit(2);
}
console.log('fake observed harness ok');
`,
  );

  const openaiSecretArgument = "child-argument-secret-openai";
  const openaiResult = await runCli(
    [
      "observe",
      "--name",
      "My Agent",
      "--base-url-env",
      "OPENAI_BASE_URL",
      "--viewer-url",
      viewer.url,
      "--conversation-id",
      "observe-openai-conversation",
      "--",
      "my-agent",
      `--private=${openaiSecretArgument}`,
    ],
    {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      OPENAI_BASE_URL: `${upstreamUrl}/v1`,
      OPENAI_API_KEY: "openai-observe-secret",
      PEEK_FAKE_OBSERVE_PROTOCOL: "openai",
      PEEK_FAKE_OBSERVE_ORIGINAL_BASE_URL: `${upstreamUrl}/v1`,
      PEEK_FAKE_OBSERVE_STATE_PATH: childStatePath,
    },
  );
  assert.equal(openaiResult.code, 0, openaiResult.stderr);
  assert.match(openaiResult.stdout, /fake observed harness ok/);
  assert.match(openaiResult.stderr, /arguments omitted; child-only OPENAI_BASE_URL override/);
  assert.doesNotMatch(openaiResult.stderr, new RegExp(openaiSecretArgument));
  assert.doesNotMatch(openaiResult.stderr, /openai-observe-secret/);
  const openaiChild = JSON.parse(fs.readFileSync(childStatePath, "utf8"));
  assert.equal(openaiChild.baseUrlOverridden, true);
  assert.equal(openaiChild.keyPreserved, true);
  assert.deepEqual(openaiChild.args, [`--private=${openaiSecretArgument}`]);
  assert.equal(wireRequests[0].path, "/v1/responses", "the original /v1 base path is preserved");
  assert.equal(wireRequests[0].authorization, "Bearer openai-observe-secret");

  const openaiSource = await sourceForConversation(viewer.url, "observe-openai-conversation");
  assert.equal(openaiSource.agent, "My Agent");
  assert.equal(openaiSource.live_status, "stopped");
  assert.equal(openaiSource.request_count, 1);
  assert.equal(openaiSource.response_count, 1);
  const openaiView = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(openaiSource.id)}`);
  assert.equal(openaiView.requests[0].summary.protocol_exchange.protocol, "openai_responses");
  assert.equal(openaiView.requests[0].summary.protocol_exchange.response.counts.output_items, 1);
  assert.equal(openaiView.requests[0].summary.response.preview, "OpenAI observe response");
  assert.equal(openaiView.requests[0].raw.headers.authorization, "[REDACTED:header]");
  assert.equal(openaiView.requests[0].raw.provenance.request.fidelity, "exact");
  assert.equal(openaiView.requests[0].raw.provenance.response.fidelity, "exact");

  const anthropicResult = await runCli(
    [
      "observe",
      "--name=Anthropic Lab Agent",
      "--base-url-env=ANTHROPIC_BASE_URL",
      `--viewer-url=${viewer.url}`,
      "--conversation-id=observe-anthropic-conversation",
      "--",
      "my-agent",
      "--mode=test",
    ],
    {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      ANTHROPIC_BASE_URL: upstreamUrl,
      ANTHROPIC_API_KEY: "anthropic-observe-secret",
      PEEK_FAKE_OBSERVE_PROTOCOL: "anthropic",
      PEEK_FAKE_OBSERVE_ORIGINAL_BASE_URL: upstreamUrl,
      PEEK_FAKE_OBSERVE_STATE_PATH: childStatePath,
    },
  );
  assert.equal(anthropicResult.code, 0, anthropicResult.stderr);
  assert.match(anthropicResult.stderr, /arguments omitted; child-only ANTHROPIC_BASE_URL override/);
  assert.doesNotMatch(anthropicResult.stderr, /anthropic-observe-secret/);
  const anthropicChild = JSON.parse(fs.readFileSync(childStatePath, "utf8"));
  assert.equal(anthropicChild.baseUrlOverridden, true);
  assert.equal(anthropicChild.keyPreserved, true);
  assert.deepEqual(anthropicChild.args, ["--mode=test"]);
  assert.equal(wireRequests[1].path, "/v1/messages");
  assert.equal(wireRequests[1].apiKey, "anthropic-observe-secret");

  const anthropicSource = await sourceForConversation(viewer.url, "observe-anthropic-conversation");
  assert.equal(anthropicSource.agent, "Anthropic Lab Agent");
  assert.equal(anthropicSource.live_status, "stopped");
  assert.equal(anthropicSource.request_count, 1);
  assert.equal(anthropicSource.response_count, 1);
  const anthropicView = await getJson(`${viewer.url}/api/view?source=${encodeURIComponent(anthropicSource.id)}`);
  assert.equal(anthropicView.requests[0].summary.protocol_exchange.protocol, "anthropic_messages");
  assert.equal(anthropicView.requests[0].summary.protocol_exchange.response.counts.output_items, 1);
  assert.equal(anthropicView.requests[0].summary.response.preview, "Anthropic observe response");
  assert.equal(anthropicView.requests[0].raw.headers["x-api-key"], "[REDACTED:header]");

  const failureResult = await runCli(
    [
      "observe",
      "--name",
      "Failing Agent",
      "--base-url-env",
      "OPENAI_BASE_URL",
      "--target-base-url",
      `${upstreamUrl}/v1`,
      "--viewer-url",
      viewer.url,
      "--conversation-id",
      "observe-failure-conversation",
      "--",
      "my-agent",
      "--secret-child-argument",
    ],
    {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      OPENAI_API_KEY: "openai-observe-secret",
      PEEK_FAKE_OBSERVE_PROTOCOL: "openai",
      PEEK_FAKE_OBSERVE_ORIGINAL_BASE_URL: "",
      PEEK_FAKE_OBSERVE_STATE_PATH: childStatePath,
      PEEK_FAKE_OBSERVE_FAIL: "1",
    },
  );
  assert.equal(failureResult.code, 17, failureResult.stderr);
  assert.match(failureResult.stderr, /fake observed harness failed/);
  assert.doesNotMatch(failureResult.stderr, /--secret-child-argument/);
  const failureSource = await sourceForConversation(viewer.url, "observe-failure-conversation");
  assert.equal(failureSource.live_status, "stopped");
  assert.equal(failureSource.request_count, 0);

  const spawnErrorResult = await runCli(
    [
      "observe",
      "--name",
      "Missing Command Agent",
      "--base-url-env",
      "OPENAI_BASE_URL",
      "--target-base-url",
      `${upstreamUrl}/v1`,
      "--viewer-url",
      viewer.url,
      "--conversation-id",
      "observe-spawn-error-conversation",
      "--",
      "pma-observe-command-does-not-exist",
      "--secret-child-argument",
    ],
    process.env,
  );
  assert.equal(spawnErrorResult.code, 1);
  assert.doesNotMatch(spawnErrorResult.stderr, /--secret-child-argument/);
  const spawnErrorSource = await sourceForConversation(viewer.url, "observe-spawn-error-conversation");
  assert.equal(spawnErrorSource.live_status, "stopped");
  assert.equal(spawnErrorSource.request_count, 0);

  const invalidEnv = await runCli(["observe", "--name", "Bad Agent", "--base-url-env", "BAD-NAME", "--", "my-agent"], process.env);
  assert.equal(invalidEnv.code, 1);
  assert.match(invalidEnv.stderr, /Invalid base URL environment variable name/);
  const missingSeparator = await runCli(["observe", "--name", "Bad Agent", "--base-url-env", "OPENAI_BASE_URL", "my-agent"], process.env);
  assert.equal(missingSeparator.code, 1);
  assert.match(missingSeparator.stderr, /requires "--"/);
  const missingBaseEnv = { ...process.env };
  delete missingBaseEnv.PMA_OBSERVE_MISSING_BASE_URL;
  const missingBase = await runCli(
    [
      "observe",
      "--name",
      "Missing Base Agent",
      "--base-url-env",
      "PMA_OBSERVE_MISSING_BASE_URL",
      "--viewer-url",
      viewer.url,
      "--",
      "my-agent",
    ],
    missingBaseEnv,
  );
  assert.equal(missingBase.code, 1);
  assert.match(missingBase.stderr, /Missing upstream base URL/);
  const unknownOption = await runCli(
    ["observe", "--name", "Bad Agent", "--base-url-env", "OPENAI_BASE_URL", "--mystery", "--", "my-agent"],
    process.env,
  );
  assert.equal(unknownOption.code, 1);
  assert.match(unknownOption.stderr, /Unknown pma observe option/);
  const credentialUrl = await runCli(
    [
      "observe",
      "--name",
      "Bad URL Agent",
      "--base-url-env",
      "OPENAI_BASE_URL",
      "--target-base-url",
      "http://user:password@127.0.0.1:9/v1",
      "--viewer-url",
      viewer.url,
      "--",
      "my-agent",
    ],
    process.env,
  );
  assert.equal(credentialUrl.code, 1);
  assert.match(credentialUrl.stderr, /must not contain credentials/);
  assert.doesNotMatch(credentialUrl.stderr, /user:password/);

  console.log("observe wrapper smoke passed (OpenAI Responses, Anthropic Messages, child-only env, privacy, cleanup)");
} finally {
  await viewer.close();
  await closeServer(upstream);
  if (previousStateDir === undefined) delete process.env.PEEKMYAGENT_STATE_DIR;
  else process.env.PEEKMYAGENT_STATE_DIR = previousStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/peekmyagent.mjs", ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: ${args[0] || "unknown"}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function sourceForConversation(viewerUrl, conversationId) {
  const sources = await getJson(`${viewerUrl}/api/sources`);
  const source = sources.find((item) => item.conversation_id === conversationId);
  assert.ok(source, `missing source for ${conversationId}`);
  return source;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
