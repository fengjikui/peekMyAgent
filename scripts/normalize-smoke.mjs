import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { normalizeOpenClawProxyCapture } from "../src/adapters/openclaw-proxy.mjs";
import { normalizeClaudeOtelRequestBody, normalizeClaudeOtelRequestFile } from "../src/adapters/claude-otel.mjs";

const root = process.cwd();
const openclawFixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "openclaw-chat-completions-capture.json"), "utf8"));
const claudeFixture = path.join(root, "fixtures", "claude-otel-request.json");

const openclaw = normalizeOpenClawProxyCapture(openclawFixture);
assert.equal(openclaw.source_agent, "OpenClaw");
assert.equal(openclaw.capture_confidence, "exact");
assert.equal(openclaw.provider_protocol, "openai-chat-completions");
assert.equal(openclaw.model, "peek/peek-test");
assert.equal(openclaw.messages.length, 4);
assert.equal(openclaw.source.headers.authorization, "[REDACTED:header]");

const openclawUnknown = normalizeOpenClawProxyCapture({
  method: "GET",
  path: "/health?api_key=sk-test-leak",
  headers: { authorization: "Bearer sk-test-leak" },
  body: { ok: true },
});
assert.equal(openclawUnknown.capture_confidence, "partial");
assert.equal(openclawUnknown.is_final_remote_request, false);
assert.equal(openclawUnknown.endpoint, "/health?api_key=%5BREDACTED%5D");

const openclawTrailingSlash = normalizeOpenClawProxyCapture({
  method: "POST",
  path: "/v1/chat/completions/",
  body: { model: "peek/peek-test", messages: [{ role: "user", content: "hello sk-test-secret0000" }] },
});
assert.equal(openclawTrailingSlash.capture_confidence, "exact");
assert.ok(openclawTrailingSlash.redactions.some((entry) => entry.reason === "secret_pattern"));

const claude = normalizeClaudeOtelRequestFile(claudeFixture);
assert.equal(claude.source_agent, "Claude Code");
assert.equal(claude.capture_confidence, "exact");
assert.equal(claude.provider_protocol, "anthropic-messages");
assert.equal(claude.model, "claude-smoke-test");
assert.equal(claude.system[0].role, "system");
assert.equal(claude.messages[0].role, "user");
assert.equal(claude.tools.length, 1);
assert.equal(claude.provenance.request.fidelity, "exact");
assert.equal(claude.provenance.response.fidelity, "missing");
assert.equal(claude.provenance.association.confidence, "none");

const claudeSystemBlocks = normalizeClaudeOtelRequestBody({
  model: "claude-smoke-test",
  system: [{ type: "text", text: "system block text" }],
  messages: [{ role: "user", content: "hello" }],
});
assert.equal(claudeSystemBlocks.system[0].content_text, "system block text");
assert.equal(claudeSystemBlocks.messages[0].role, "user");

const outPath = process.env.PEEK_NORMALIZE_SMOKE_REPORT || path.join(root, "tmp", "normalize-smoke", "normalize-smoke-report.md");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const report = [
  "# Adapter normalize smoke report",
  "",
  `生成时间：${new Date().toISOString()}`,
  "",
  "| Adapter | Agent | Confidence | Messages | Tools | Model |",
  "| --- | --- | --- | --- | --- | --- |",
  `| ${openclaw.adapter_name} | ${openclaw.source_agent} | ${openclaw.capture_confidence} | ${openclaw.messages.length} | ${openclaw.tools.length} | ${openclaw.model} |`,
  `| ${claude.adapter_name} | ${claude.source_agent} | ${claude.capture_confidence} | ${claude.messages.length} (+${claude.system.length} system) | ${claude.tools.length} | ${claude.model} |`,
  "",
  "结论：OpenClaw proxy capture 与 Claude OTel raw body 已能规范化为统一请求对象。",
  "",
].join("\n");
fs.writeFileSync(outPath, report);
console.log(`Wrote ${outPath}`);
console.log({ openclaw: openclaw.adapter_name, claude: claude.adapter_name });
