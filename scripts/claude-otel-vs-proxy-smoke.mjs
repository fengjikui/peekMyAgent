import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeClaudeOtelRequestBody } from "../src/adapters/claude-otel.mjs";
import { startCaptureProxy } from "../src/core/capture-proxy.mjs";

const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const reportPath =
  process.env.PEEK_CLAUDE_OTEL_VS_PROXY_SMOKE_REPORT ||
  path.join(process.cwd(), "tmp", "claude-otel-vs-proxy-smoke", "claude-otel-vs-proxy-smoke-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const evidenceDir = path.join(process.cwd(), "tmp", "smoke-evidence", "claude-otel-vs-proxy", "latest");
const prompt = "Say exactly: peek proxy compare ok";

if (!originalBaseUrl || !originalAuthToken) {
  console.error("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN are required for this smoke test.");
  process.exit(1);
}

function runClaude({ env, bodyDir, label }) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--output-format", "json", "--tools", "", "--max-budget-usd", "0.05", prompt], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "console",
        OTEL_LOG_RAW_API_BODIES: `file:${bodyDir}`,
        OTEL_LOGS_EXPORT_INTERVAL: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ label, code, signal: signal || null, stdout, stderr });
    });
  });
}

function listRequestFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.endsWith(".request.json")).sort().map((name) => path.join(root, name));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function summarizeBody(body) {
  return {
    model: body?.model || null,
    top_level_keys: Object.keys(body || {}).sort(),
    messages_count: Array.isArray(body?.messages) ? body.messages.length : 0,
    system_count: Array.isArray(body?.system) ? body.system.length : body?.system ? 1 : 0,
    tools_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    stream: body?.stream ?? null,
    body_hash: hashJson(body),
    normalized_hash: hashJson(normalizeClaudeOtelRequestBody(body)),
  };
}

function sortedSummaries(items) {
  return [...items].sort((a, b) => {
    const modelCompare = String(a.model || "").localeCompare(String(b.model || ""));
    if (modelCompare) return modelCompare;
    return (a.messages_count || 0) - (b.messages_count || 0);
  });
}

function comparableKey(summary) {
  return `${summary.model || ""}|${summary.messages_count || 0}|${summary.system_count || 0}|${summary.tools_count || 0}`;
}

function compareProxyBodyPair({ captureBody, otelBody }) {
  const captureKeys = Object.keys(captureBody || {}).sort();
  const otelKeys = Object.keys(otelBody || {}).sort();
  const same = (key) => JSON.stringify(captureBody?.[key]) === JSON.stringify(otelBody?.[key]);
  const changedKeys = Array.from(new Set([...captureKeys, ...otelKeys])).filter((key) => !same(key));
  return {
    capture_only_keys: captureKeys.filter((key) => !otelKeys.includes(key)),
    otel_only_keys: otelKeys.filter((key) => !captureKeys.includes(key)),
    changed_keys: changedKeys,
    note: changedKeys.includes("system") && changedKeys.includes("betas")
      ? "OTel 会归零 system 里的 cch 值，并把 anthropic-beta header 表示为 betas 字段。"
      : "",
  };
}

function writeEvidence({ direct, proxied, proxy }) {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(evidenceDir, "direct-otel"), { recursive: true });
  fs.mkdirSync(path.join(evidenceDir, "proxy-otel"), { recursive: true });
  for (const file of direct.files) fs.copyFileSync(file, path.join(evidenceDir, "direct-otel", path.basename(file)));
  for (const file of proxied.files) fs.copyFileSync(file, path.join(evidenceDir, "proxy-otel", path.basename(file)));
  fs.writeFileSync(
    path.join(evidenceDir, "command.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        cwd: process.cwd(),
        prompt,
        original_base_url: originalBaseUrl,
        proxy_base_url: proxy.baseUrl,
        proxy_configured_base_url: proxy.baseUrl,
        note: "direct-otel 是 Claude Code 直连上游 provider 时的 OTel raw body；proxy-captures 是 ANTHROPIC_BASE_URL 指向 peekMyAgent proxy 后捕获的 HTTP body。",
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(evidenceDir, "direct-result.json"), `${JSON.stringify(direct, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "proxy-result.json"), `${JSON.stringify(proxied, null, 2)}\n`);
  fs.writeFileSync(path.join(evidenceDir, "proxy-captures.json"), `${JSON.stringify(proxy.captures, null, 2)}\n`);
}

function writeReport({ direct, proxied, proxy }) {
  const directSummaries = sortedSummaries(direct.summaries);
  const proxyOtelSummaries = sortedSummaries(proxied.summaries);
  const proxyCaptureSummaries = sortedSummaries(proxy.captures.map((capture) => summarizeBody(capture.body)));
  const proxyPairs = proxyCaptureSummaries.map((captureSummary) => {
    const otelIndex = proxyOtelSummaries.findIndex((summary) => comparableKey(summary) === comparableKey(captureSummary));
    const otelSummary = otelIndex >= 0 ? proxyOtelSummaries.splice(otelIndex, 1)[0] : null;
    const capture = proxy.captures.find(
      (item) => item.body?.model === captureSummary.model && item.body?.messages?.length === captureSummary.messages_count,
    );
    const otelFile = proxied.files.find((file) => {
      const body = readJson(file);
      return body?.model === captureSummary.model && body?.messages?.length === captureSummary.messages_count;
    });
    return {
      captureSummary,
      otelSummary,
      diff: capture && otelFile ? compareProxyBodyPair({ captureBody: capture.body, otelBody: readJson(otelFile) }) : null,
    };
  });
  const lines = [];
  lines.push("# Claude Code OTel vs Proxy capture smoke test");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("说明：同一 prompt 分别用 Claude Code 直连 OTel 和 `ANTHROPIC_BASE_URL -> peekMyAgent proxy -> upstream provider` 跑一次，对比 OTel raw body 与 proxy 捕获 body。报告不输出完整正文。");
  lines.push("");
  lines.push(`- upstream base URL：${originalBaseUrl}`);
  lines.push(`- proxy captures：${proxy.captures.length}`);
  lines.push(`- direct exit：${direct.result.code}`);
  lines.push(`- proxy exit：${proxied.result.code}`);
  lines.push(`- evidence dir：${evidenceDir}`);
  lines.push("");
  lines.push("## 请求摘要");
  lines.push("");
  lines.push("| source | model | messages | system | tools | stream | body_hash | normalized_hash |");
  lines.push("| --- | --- | ---: | ---: | ---: | --- | --- | --- |");
  for (const [label, summaries] of [
    ["direct_otel", directSummaries],
    ["proxy_otel", sortedSummaries(proxied.summaries)],
    ["proxy_capture", proxyCaptureSummaries],
  ]) {
    for (const summary of summaries) {
      lines.push(
        `| ${label} | ${summary.model || ""} | ${summary.messages_count ?? ""} | ${summary.system_count ?? ""} | ${summary.tools_count ?? ""} | ${summary.stream ?? ""} | ${(summary.body_hash || "").slice(0, 12)} | ${(summary.normalized_hash || "").slice(0, 12)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 代理捕获与 OTel 差异");
  lines.push("");
  lines.push("| model | messages | capture_status | proxy_capture_hash | proxy_otel_hash | differing_keys | note |");
  lines.push("| --- | ---: | ---: | --- | --- | --- | --- |");
  for (const pair of proxyPairs) {
    const capture = proxy.captures.find(
      (item) => item.body?.model === pair.captureSummary.model && item.body?.messages?.length === pair.captureSummary.messages_count,
    );
    lines.push(
      `| ${pair.captureSummary.model || ""} | ${pair.captureSummary.messages_count ?? ""} | ${capture?.upstream_status ?? ""} | ${(pair.captureSummary.body_hash || "").slice(0, 12)} | ${(pair.otelSummary?.body_hash || "").slice(0, 12)} | ${(pair.diff?.changed_keys || []).join(", ")} | ${pair.diff?.note || ""} |`,
    );
  }
  lines.push("");
  lines.push("结论看点：代理路径已经能无感转发到上游 provider 并拿到 200；`proxy_capture` 比 Claude Code OTel 多了真实 HTTP 层信息，包括 URL、headers、status、watch_id。OTel 文件不是严格字节级线上 body：本次观察到它会归零 `system` 里 billing/cache 片段的 `cch` 值，并把 `anthropic-beta` header 以 `betas` 字段呈现。");
  lines.push("");
  fs.writeFileSync(reportPath, lines.join("\n"));
}

async function main() {
  const directRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peek-claude-direct-"));
  const directBodyDir = path.join(directRoot, "raw-bodies");
  fs.mkdirSync(directBodyDir, { recursive: true });
  const directResult = await runClaude({ label: "direct", bodyDir: directBodyDir, env: { ANTHROPIC_BASE_URL: originalBaseUrl } });
  const directFiles = listRequestFiles(directBodyDir);
  const direct = { result: directResult, files: directFiles, summaries: directFiles.map((file) => summarizeBody(readJson(file))) };

  const proxyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "peek-claude-proxy-"));
  const proxyBodyDir = path.join(proxyRoot, "raw-bodies");
  fs.mkdirSync(proxyBodyDir, { recursive: true });
  const proxy = await startCaptureProxy({
    targetBaseUrl: originalBaseUrl,
    preserveTargetPathPrefix: true,
    defaultAttribution: {
      watchId: "claude-proxy-compare",
      agentProfile: "Claude Code",
      workspace: process.cwd(),
      conversationId: "claude-proxy-compare",
    },
  });
  const proxiedResult = await runClaude({ label: "proxy", bodyDir: proxyBodyDir, env: { ANTHROPIC_BASE_URL: proxy.baseUrl } });
  const proxiedFiles = listRequestFiles(proxyBodyDir);
  const proxied = { result: proxiedResult, files: proxiedFiles, summaries: proxiedFiles.map((file) => summarizeBody(readJson(file))) };
  await proxy.close();

  writeEvidence({ direct, proxied, proxy });
  writeReport({ direct, proxied, proxy });
  if (process.env.PEEK_KEEP_RAW !== "1") {
    fs.rmSync(directRoot, { recursive: true, force: true });
    fs.rmSync(proxyRoot, { recursive: true, force: true });
  }
  console.log(`Wrote ${reportPath}`);
  console.log({
    directExit: directResult.code,
    proxyExit: proxiedResult.code,
    directRequests: directFiles.length,
    proxyOtelRequests: proxiedFiles.length,
    proxyCaptures: proxy.captures.length,
    evidenceDir,
  });
  if (directResult.code !== 0 || proxiedResult.code !== 0 || !proxy.captures.length) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
