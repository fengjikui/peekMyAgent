#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCaptureProxy } from "../src/core/capture-proxy.mjs";

const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
const experimentName = "claude-code-trace-clarity-exp1";
const outputRoot = path.join(process.cwd(), "tmp", "trace-clarity", experimentName);
const evidenceDir = path.join(outputRoot, "latest");
const reportPath =
  process.env.PEEK_TRACE_CLARITY_CLAUDE_EXPERIMENT_REPORT ||
  path.join(process.cwd(), "tmp", "trace-clarity-claude-experiment", "trace-clarity-claude-experiment-report.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const watchId = "trace-clarity-claude-exp1";
const conversationId = `${watchId}-${Date.now()}`;
const preflightModel = process.env.PEEK_TRACE_CLAUDE_PREFLIGHT_MODEL || process.env.ANTHROPIC_MODEL || "deepseek-v4-pro";
const skipPreflight = process.env.PEEK_TRACE_SKIP_PREFLIGHT === "1";
const subagentFanout = Number(process.env.PEEK_TRACE_CLAUDE_SUBAGENTS || "3");
const maxBudgetUsd = process.env.PEEK_TRACE_CLAUDE_MAX_BUDGET_USD || "1.00";
const promptSummary = `read-only temporary project inspection with optional ${subagentFanout} subagents`;

if (!originalBaseUrl || !originalAuthToken) {
  console.error("ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY are required.");
  process.exit(1);
}

const prompt = [
  "This is a read-only trace clarity experiment for peekMyAgent.",
  "Work inside this temporary project only.",
  "Goal: inspect how this project is organized and explain what a trace viewer should show.",
  "",
  "Please do all of the following:",
  "1. Read package.json and README.md.",
  "2. Inspect src/trace-viewer.js and src/agent-flow.js.",
  "3. Inspect docs/agent-trace-notes.md.",
  `4. If a Task, Agent, Explore, or subagent tool is available, use exactly ${subagentFanout} subagents in parallel:`,
  "   - Subagent A inspects src/trace-viewer.js and summarizes turn/tool-chain presentation needs.",
  "   - Subagent B inspects src/agent-flow.js and docs/agent-trace-notes.md, then summarizes parent/child agent signals.",
  "   - Subagent C inspects package.json, README.md, and docs/agent-trace-notes.md, then summarizes raw-evidence and user-facing trace requirements.",
  "5. If subagents are unavailable, explicitly say so and continue with direct reads. If fewer than three subagents can be launched, say exactly how many were launched.",
  "6. Do not modify any file.",
  "7. Final answer: concise bullets describing what you inspected and how a viewer should present this trace.",
].join("\n");

async function main() {
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const workspace = path.join(evidenceDir, "workspace");
  const bodyDir = path.join(evidenceDir, "otel-raw-bodies");
  const debugFile = path.join(evidenceDir, "claude-debug.log");
  fs.mkdirSync(bodyDir, { recursive: true });
  createExperimentWorkspace(workspace);

  const preflight = skipPreflight ? { skipped: true, reason: "PEEK_TRACE_SKIP_PREFLIGHT=1" } : await providerPreflight();
  writeJson(path.join(evidenceDir, "preflight.json"), preflight);
  if (!preflight.skipped && !preflight.ok) {
    const traceObservation = emptyTraceObservation({ workspace, preflight });
    writeExperimentEvidence({ workspace, preflight, result: null, captures: [], debugApiSources: [], otelObservations: [], traceObservation });
    writeReport({ traceObservation, result: null });
    console.log(`Wrote ${reportPath}`);
    console.log(`Evidence: ${evidenceDir}`);
    console.log(
      JSON.stringify(
        {
          exit: 1,
          preflight_status: preflight.status || null,
          preflight_error: preflight.error || null,
          proxy_captures: 0,
          otel_requests: 0,
          evidence_dir: evidenceDir,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const proxy = await startCaptureProxy({
    targetBaseUrl: originalBaseUrl,
    preserveTargetPathPrefix: true,
    defaultAttribution: {
      watchId,
      agentProfile: "Claude Code",
      workspace,
      conversationId,
    },
  });

  let result;
  try {
    result = await runClaude({ workspace, proxyBaseUrl: proxy.baseUrl, bodyDir, debugFile });
  } finally {
    await proxy.close();
  }

  const debugApiSources = parseDebugApiSources(debugFile);
  const captureObservations = proxy.captures.map((capture, index) => observeCapture(capture, debugApiSources[index] || null));
  const otelFiles = listRequestFiles(bodyDir);
  const otelObservations = otelFiles.map((file, index) => observeOtelFile(file, index + 1));
  const traceObservation = {
    experiment: experimentName,
    generated_at: new Date().toISOString(),
    watch_id: watchId,
    agent: "Claude Code",
    workspace,
    conversation_id: conversationId,
    prompt_summary: promptSummary,
    requested_subagent_fanout: subagentFanout,
    claude_exit: result.code,
    claude_signal: result.signal,
    proxy_capture_count: proxy.captures.length,
    otel_request_count: otelObservations.length,
    preflight,
    debug_source_counts: countBy(debugApiSources.map((item) => item.source || "unknown")),
    captures: captureObservations,
    child_agent_instances: childAgentInstances(captureObservations),
    otel_requests: otelObservations,
    initial_findings: inferFindings(captureObservations, debugApiSources),
  };

  writeExperimentEvidence({ workspace, proxyBaseUrl: proxy.baseUrl, preflight, result, captures: proxy.captures, debugApiSources, otelObservations, traceObservation });
  writeReport({ traceObservation, result });

  console.log(`Wrote ${reportPath}`);
  console.log(`Evidence: ${evidenceDir}`);
  console.log(
    JSON.stringify(
      {
        exit: result.code,
        preflight_status: preflight.status || null,
        proxy_captures: proxy.captures.length,
        otel_requests: otelObservations.length,
        debug_sources: traceObservation.debug_source_counts,
        evidence_dir: evidenceDir,
      },
      null,
      2,
    ),
  );

  if (result.code !== 0 || proxy.captures.length === 0) process.exitCode = 1;
}

function writeExperimentEvidence({ workspace, proxyBaseUrl = null, preflight, result, captures, debugApiSources, otelObservations, traceObservation }) {
  writeJson(path.join(evidenceDir, "command.json"), {
    generated_at: traceObservation.generated_at,
    cwd: process.cwd(),
    workspace,
    watch_id: watchId,
    conversation_id: conversationId,
    proxy_base_url: proxyBaseUrl,
    original_base_url_host: safeHost(originalBaseUrl),
    preflight,
    prompt,
    note: "Raw proxy captures and OTel files are local experiment evidence. Do not publish without redaction.",
  });
  writeJson(path.join(evidenceDir, "result.json"), result);
  writeJson(path.join(evidenceDir, "stdout-parsed.json"), parseMaybeJson(result?.stdout || ""));
  writeJson(path.join(evidenceDir, "proxy-captures.json"), captures);
  writeJson(path.join(evidenceDir, "trace-observation.json"), traceObservation);
  writeJson(path.join(evidenceDir, "debug-api-sources.json"), debugApiSources);
  writeJson(path.join(evidenceDir, "otel-observations.json"), otelObservations);
}

function emptyTraceObservation({ workspace, preflight }) {
  return {
    experiment: experimentName,
    generated_at: new Date().toISOString(),
    watch_id: watchId,
    agent: "Claude Code",
    workspace,
    conversation_id: conversationId,
    prompt_summary: promptSummary,
    requested_subagent_fanout: subagentFanout,
    claude_exit: null,
    claude_signal: null,
    proxy_capture_count: 0,
    otel_request_count: 0,
    preflight,
    debug_source_counts: {},
    captures: [],
    child_agent_instances: [],
    otel_requests: [],
    initial_findings: [
      "Provider preflight failed before launching Claude Code; refresh credentials before collecting a live trace.",
    ],
  };
}

async function providerPreflight() {
  const startedAt = Date.now();
  const url = appendPath(originalBaseUrl, "/v1/messages");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": originalAuthToken,
        authorization: `Bearer ${originalAuthToken}`,
      },
      body: JSON.stringify({
        model: preflightModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return {
      ok: response.ok,
      skipped: false,
      status: response.status,
      status_text: response.statusText,
      duration_ms: Date.now() - startedAt,
      url_host: safeHost(url),
      model: preflightModel,
      body_preview: sanitizePreview(bodyText, 500),
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error.name || "Error",
      message: error.message,
      duration_ms: Date.now() - startedAt,
      url_host: safeHost(url),
      model: preflightModel,
    };
  } finally {
    clearTimeout(timer);
  }
}

function createExperimentWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
  writeText(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "trace-clarity-sandbox",
        version: "0.1.0",
        private: true,
        scripts: {
          test: "node src/agent-flow.js",
          lint: "node -c src/trace-viewer.js",
        },
      },
      null,
      2,
    ),
  );
  writeText(
    path.join(workspace, "README.md"),
    [
      "# Trace clarity sandbox",
      "",
      "This temporary project is used to observe how Claude Code decomposes a read-only code inspection task.",
      "It contains a tiny trace viewer model and an agent-flow sketch.",
    ].join("\n"),
  );
  writeText(
    path.join(workspace, "src/trace-viewer.js"),
    [
      "export function groupRequestsIntoTurns(requests) {",
      "  const turns = [];",
      "  for (const request of requests) {",
      "    const latestUser = request.latestUser || 'unknown';",
      "    let turn = turns.find((item) => item.latestUser === latestUser);",
      "    if (!turn) {",
      "      turn = { latestUser, requests: [], toolEvents: [], branches: [] };",
      "      turns.push(turn);",
      "    }",
      "    turn.requests.push(request);",
      "    if (request.toolCalls) turn.toolEvents.push(...request.toolCalls);",
      "    if (request.branch) turn.branches.push(request.branch);",
      "  }",
      "  return turns;",
      "}",
      "",
      "export function describeTrace(turn) {",
      "  return `${turn.latestUser}: ${turn.requests.length} requests, ${turn.toolEvents.length} tool events, ${turn.branches.length} branches`;",
      "}",
    ].join("\n"),
  );
  writeText(
    path.join(workspace, "src/agent-flow.js"),
    [
      "const flow = [",
      "  { event: 'user_input', text: 'inspect project' },",
      "  { event: 'model_request', actor: 'main' },",
      "  { event: 'tool_call', tool: 'Read', actor: 'main' },",
      "  { event: 'tool_result', tool: 'Read', actor: 'main' },",
      "  { event: 'subagent_spawn', actor: 'main', child: 'inspector-a' },",
      "  { event: 'model_request', actor: 'inspector-a' },",
      "  { event: 'subagent_result', child: 'inspector-a' },",
      "  { event: 'final_response', actor: 'main' },",
      "];",
      "",
      "console.log(JSON.stringify(flow, null, 2));",
      "export default flow;",
    ].join("\n"),
  );
  writeText(
    path.join(workspace, "docs/agent-trace-notes.md"),
    [
      "# Agent trace notes",
      "",
      "A good trace view should show raw evidence and a readable understanding layer.",
      "",
      "- Tool chains should stay under the same user turn unless a new real user command starts.",
      "- Subagents should be shown as branches when parent-child evidence is available.",
      "- Timing is useful evidence, but it should not be the only parent-child attribution signal.",
      "- Raw requests and responses must remain inspectable.",
    ].join("\n"),
  );
}

function runClaude({ workspace, proxyBaseUrl, bodyDir, debugFile }) {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--tools",
        "default",
        "--permission-mode",
        "bypassPermissions",
        "--max-budget-usd",
        maxBudgetUsd,
        "--debug-file",
        debugFile,
        prompt,
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: proxyBaseUrl,
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_LOGS_EXPORTER: "console",
          OTEL_LOG_RAW_API_BODIES: `file:${bodyDir}`,
          OTEL_LOGS_EXPORT_INTERVAL: "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 420_000);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal || null, stdout, stderr });
    });
  });
}

function observeCapture(capture, debugSource) {
  const body = capture.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const latestUser = latestMessageText(messages, "user");
  const requestToolCalls = extractToolCallsFromMessages(messages);
  const requestToolResults = extractToolResultsFromMessages(messages);
  const responseSummary = summarizeResponse(capture.response);
  const subagentMarkers = subagentMarkersFor({ capture, debugSource, latestUser, requestToolCalls, responseSummary });
  const claudeAgentId = headerValue(capture.headers, "x-claude-code-agent-id");
  return {
    capture_id: capture.capture_id,
    request_index: capture.request_index,
    captured_at: capture.received_at,
    debug_source: debugSource?.source || null,
    api_source: body.api_source || body.metadata?.api_source || null,
    agent_profile: capture.agent_profile || null,
    model: body.model || null,
    path: capture.path,
    status: capture.upstream_status || capture.response?.status || null,
    claude_agent_id: claudeAgentId || null,
    roles: messages.map((message) => message.role || "unknown"),
    system_count: countSystem(body),
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    latest_user_preview: preview(latestUser, 220),
    latest_user_hash: latestUser ? sha(latestUser).slice(0, 12) : "",
    tool_call_names: requestToolCalls.map((call) => call.name),
    tool_call_ids: requestToolCalls.map((call) => call.id).filter(Boolean),
    tool_result_ids: requestToolResults.map((result) => result.id).filter(Boolean),
    response_tool_call_names: responseSummary.tool_calls.map((call) => call.name),
    response_tool_call_ids: responseSummary.tool_calls.map((call) => call.id).filter(Boolean),
    response_message_id: responseSummary.message_id,
    response_text_preview: preview(responseSummary.text, 220),
    finish_reason: responseSummary.finish_reason,
    usage: responseSummary.usage,
    response_stream: responseSummary.stream,
    response_event_count: responseSummary.event_count,
    response_latency_ms: capture.response?.duration_ms ?? null,
    subagent_markers: subagentMarkers,
    parent_link_candidates: parentLinkCandidates({ requestToolCalls, responseSummary, latestUser, debugSource }),
    turn_link_candidates: turnLinkCandidates({ latestUser, messages }),
    presentation_notes: presentationNotes({ subagentMarkers, requestToolCalls, responseSummary, messages }),
  };
}

function observeOtelFile(file, index) {
  const body = readJson(file);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const latestUser = latestMessageText(messages, "user");
  return {
    file_index: index,
    file: path.basename(file),
    model: body.model || null,
    roles: messages.map((message) => message.role || "unknown"),
    system_count: countSystem(body),
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    latest_user_hash: latestUser ? sha(latestUser).slice(0, 12) : "",
    latest_user_preview: preview(latestUser, 180),
    request_tool_call_names: extractToolCallsFromMessages(messages).map((call) => call.name),
    tool_result_ids: extractToolResultsFromMessages(messages).map((result) => result.id).filter(Boolean),
  };
}

function summarizeResponse(response) {
  if (!response) return { message_id: null, text: "", tool_calls: [], usage: null, finish_reason: null, stream: false, event_count: 0 };
  const contentType = headerValue(response.headers, "content-type");
  const bodyText = response.body_text || "";
  const stream = /event-stream/i.test(contentType) || /^\s*(event:|data:)/m.test(bodyText);
  if (stream) return summarizeSseResponse(bodyText);
  return summarizeJsonResponse(response.body_json);
}

function summarizeJsonResponse(body) {
  if (!body || typeof body !== "object") return { message_id: null, text: "", tool_calls: [], usage: null, finish_reason: null, stream: false, event_count: 0 };
  const textParts = [];
  const toolCalls = [];
  const finishReasons = [];
  if (Array.isArray(body.content)) {
    textParts.push(contentText(body.content));
    toolCalls.push(...extractToolCallsFromContent(body.content));
  }
  if (typeof body.content === "string") textParts.push(body.content);
  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      if (choice?.message?.content) textParts.push(contentText(choice.message.content));
      if (Array.isArray(choice?.message?.tool_calls)) toolCalls.push(...normalizeOpenAiToolCalls(choice.message.tool_calls));
      if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
    }
  }
  if (body.stop_reason) finishReasons.push(body.stop_reason);
  if (body.finish_reason) finishReasons.push(body.finish_reason);
  return {
    message_id: body.id || null,
    text: textParts.filter(Boolean).join("\n"),
    tool_calls: dedupeToolCalls(toolCalls),
    usage: body.usage || null,
    finish_reason: [...new Set(finishReasons)].join(", ") || null,
    stream: false,
    event_count: 0,
  };
}

function summarizeSseResponse(text) {
  const events = parseSseEvents(text);
  const textParts = [];
  const toolCalls = [];
  const usage = [];
  const finishReasons = [];
  const toolUseBlocks = new Map();
  let messageId = null;
  for (const event of events) {
    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (data.type === "content_block_start" && data.index != null && data.content_block?.type === "tool_use") {
      toolUseBlocks.set(data.index, {
        id: data.content_block.id || null,
        name: data.content_block.name || "unknown",
        arguments: data.content_block.input || null,
      });
    }
    if (data.type === "message_start" && data.message?.id) messageId = data.message.id;
    if (data.type === "content_block_delta" && data.delta?.type === "text_delta") textParts.push(data.delta.text || "");
    if (data.type === "message_delta") {
      if (data.delta?.stop_reason) finishReasons.push(data.delta.stop_reason);
      if (data.usage) usage.push(data.usage);
    }
    if (data.usage) usage.push(data.usage);
    if (Array.isArray(data.choices)) {
      for (const choice of data.choices) {
        if (choice.delta?.content) textParts.push(choice.delta.content);
        if (choice.finish_reason) finishReasons.push(choice.finish_reason);
        if (Array.isArray(choice.delta?.tool_calls)) toolCalls.push(...normalizeOpenAiToolCalls(choice.delta.tool_calls));
      }
    }
  }
  toolCalls.push(...toolUseBlocks.values());
  return {
    message_id: messageId,
    text: textParts.join(""),
    tool_calls: dedupeToolCalls(toolCalls),
    usage: usage.at(-1) || null,
    finish_reason: [...new Set(finishReasons)].join(", ") || null,
    stream: true,
    event_count: events.length,
  };
}

function subagentMarkersFor({ capture, debugSource, latestUser, requestToolCalls, responseSummary }) {
  const markers = [];
  if (debugSource?.source?.startsWith("agent:")) markers.push({ kind: "debug_source", value: debugSource.source, confidence: "high" });
  if (bodyTextHasSubagentMarker(latestUser)) markers.push({ kind: "latest_user_marker", value: markerPreview(latestUser), confidence: "medium" });
  if (requestToolCalls.some((call) => /^(Agent|Task|sessions_spawn|subagents)$/i.test(call.name))) {
    markers.push({ kind: "request_tool_call", value: requestToolCalls.map((call) => call.name).join(","), confidence: "medium" });
  }
  if (responseSummary.tool_calls.some((call) => /^(Agent|Task|sessions_spawn|subagents)$/i.test(call.name))) {
    markers.push({ kind: "response_tool_call", value: responseSummary.tool_calls.map((call) => call.name).join(","), confidence: "medium" });
  }
  const sessionId = headerValue(capture.headers, "x-claude-code-session-id");
  if (sessionId) markers.push({ kind: "claude_session_id", value: sessionId.slice(0, 12), confidence: "low" });
  const agentId = headerValue(capture.headers, "x-claude-code-agent-id");
  if (agentId) markers.push({ kind: "claude_agent_id", value: agentId, confidence: "high" });
  return markers;
}

function parentLinkCandidates({ requestToolCalls, responseSummary, latestUser, debugSource }) {
  const candidates = [];
  for (const call of [...requestToolCalls, ...responseSummary.tool_calls]) {
    if (/^(Agent|Task|sessions_spawn|subagents)$/i.test(call.name)) {
      candidates.push({ kind: "spawn_tool_call", tool: call.name, id: call.id || null, arguments_preview: preview(stableJson(call.arguments), 260), confidence: "medium" });
    }
  }
  if (debugSource?.source?.startsWith("agent:")) candidates.push({ kind: "debug_source_child", value: debugSource.source, confidence: "medium" });
  if (bodyTextHasSubagentMarker(latestUser)) candidates.push({ kind: "child_prompt_marker", value: markerPreview(latestUser), confidence: "low" });
  return candidates;
}

function turnLinkCandidates({ latestUser, messages }) {
  const candidates = [];
  if (latestUser) candidates.push({ kind: "latest_real_user_hash", value: sha(latestUser).slice(0, 12), confidence: "medium" });
  const toolResultCount = extractToolResultsFromMessages(messages).length;
  if (toolResultCount) candidates.push({ kind: "tool_result_continuation", value: String(toolResultCount), confidence: "medium" });
  return candidates;
}

function presentationNotes({ subagentMarkers, requestToolCalls, responseSummary, messages }) {
  const notes = [];
  if (subagentMarkers.some((marker) => marker.kind === "debug_source")) notes.push("可通过 debug source 明确分离子 Agent 请求。");
  if (responseSummary.tool_calls.length) notes.push("响应中包含工具调用，下一条请求应解释为该响应触发的续写。");
  if (requestToolCalls.length) notes.push("请求历史中已有工具调用，这张卡片更可能是续写而不是新的用户 turn。");
  if (extractToolResultsFromMessages(messages).length) notes.push("请求包含工具结果；当最新用户 hash 未变时，应保留在原始 turn 内。");
  return notes;
}

function inferFindings(captures, debugApiSources) {
  const findings = [];
  const sourceCounts = countBy(debugApiSources.map((item) => item.source || "unknown"));
  if (Object.keys(sourceCounts).some((source) => source.startsWith("agent:"))) {
    findings.push("Claude debug log 暴露了 `agent:*` source，这是识别子 Agent 的强分组信号。");
  }
  const uniqueSessionIds = new Set(captures.flatMap((item) => item.subagent_markers.filter((marker) => marker.kind === "claude_session_id").map((marker) => marker.value)));
  if (uniqueSessionIds.size <= 1) findings.push("捕获到的请求共享同一个 Claude session id 前缀；session id 本身不能区分父 Agent 和子 Agent。");
  const uniqueAgentIds = new Set(captures.map((item) => item.claude_agent_id).filter(Boolean));
  if (uniqueAgentIds.size) findings.push(`观察到 ${uniqueAgentIds.size} 个不同的 \`x-claude-code-agent-id\`，可区分不同子 Agent 实例，并把同一子 Agent 的多轮请求串起来。`);
  if (captures.some((item) => item.response_tool_call_names.length)) findings.push("需要使用下行响应里的工具调用解释后续上行请求为什么发生。");
  if (captures.some((item) => item.tool_result_ids.length)) findings.push("带有 `tool_result` id 的请求通常应保留为原始用户 turn 内的续写。");
  if (!captures.some((item) => item.subagent_markers.some((marker) => marker.kind === "debug_source"))) {
    findings.push("本次运行没有暴露 `agent:*` debug source；fallback 分组需要依赖 prompt marker 或工具调用证据。");
  }
  return findings;
}

function childAgentInstances(captures) {
  const groups = new Map();
  for (const item of captures) {
    if (!item.claude_agent_id) continue;
    if (!groups.has(item.claude_agent_id)) groups.set(item.claude_agent_id, []);
    groups.get(item.claude_agent_id).push({
      request_index: item.request_index,
      capture_id: item.capture_id,
      response_message_id: item.response_message_id,
      finish_reason: item.finish_reason,
      request_tool_results: item.tool_result_ids,
      response_tool_calls: item.response_tool_call_ids.map((id, index) => ({
        id,
        name: item.response_tool_call_names[index] || "unknown",
      })),
    });
  }
  return [...groups.entries()].map(([agent_id, requests], index) => ({
    label: `子 Agent ${index + 1}`,
    agent_id,
    requests,
  }));
}

function writeReport({ traceObservation, result }) {
  const captures = traceObservation.captures;
  const stdout = result?.stdout || "";
  const stdoutJson = parseMaybeJson(stdout);
  const preflight = traceObservation.preflight || null;
  const authFailure =
    preflight?.status === 401 ||
    stdoutJson?.api_error_status === 401 ||
    /Invalid API Key|Failed to authenticate/i.test(stdout);
  const lines = [];
  lines.push("# Claude Code trace clarity 实验报告");
  lines.push("");
  lines.push(`生成时间：${traceObservation.generated_at}`);
  lines.push("");
  lines.push("用途：收集 Claude Code 长工具链和子 Agent 工作流的真实证据，为后续 Agent Trace 展示设计提供依据；本报告不直接决定最终 UI。");
  lines.push("");
  lines.push("## 运行摘要");
  lines.push("");
  lines.push(`- 临时项目：${traceObservation.workspace}`);
  lines.push(`- Claude Code 退出码：${traceObservation.claude_exit}${traceObservation.claude_signal ? ` (${traceObservation.claude_signal})` : ""}`);
  if (preflight) {
    lines.push(`- provider preflight: ${preflight.skipped ? `skipped (${preflight.reason})` : `${preflight.status || preflight.error || "unknown"}${preflight.ok ? " ok" : " failed"}`}`);
  }
  lines.push(`- proxy 捕获请求数：${traceObservation.proxy_capture_count}`);
  lines.push(`- OTel request 数：${traceObservation.otel_request_count}`);
  lines.push(`- debug source：${formatCounts(traceObservation.debug_source_counts)}`);
  lines.push(`- 预期子 Agent fanout：${traceObservation.requested_subagent_fanout}`);
  lines.push(`- 捕获到的子 Agent 实例数：${traceObservation.child_agent_instances.length}`);
  lines.push(`- evidence 目录：${evidenceDir}`);
  if (authFailure) {
    lines.push("- 状态说明：live run 已到达 provider，但认证返回 401；这份报告只是 rerun 记录，不是成功的工具/子 Agent trace 样本。");
  }
  lines.push("");
  if (authFailure) {
    lines.push("## 认证阻塞");
    lines.push("");
    if (preflight?.status === 401) {
      lines.push("- Provider preflight 返回 `401 Invalid API Key`，因此在启动 Claude Code 前停止。");
    } else {
      lines.push("- 不经过 peekMyAgent proxy 的 Claude Code 直连也返回同样的 `401 Invalid API Key`，说明失败来自当前环境凭据，而不是 capture proxy 转发。");
    }
    lines.push("- 刷新 Claude Code/provider 凭据后重新运行脚本，或在 shell 环境中提供可用的 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`。");
    lines.push("- 历史成功 evidence 仍在 `tmp/smoke-evidence/claude-subagent-proxy/latest` 和 `tmp/smoke-evidence/claude-proxy-resume/latest`。");
    lines.push("");
  }
  lines.push("## 捕获摘要");
  lines.push("");
  lines.push("| # | debug source | agent id | response id | roles | tools | 请求历史中的工具调用 | 响应中的工具调用 | finish | 子 Agent 标记 | 最新 user 摘要 | 响应摘要 |");
  lines.push("| ---: | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |");
  for (const item of captures) {
    lines.push(
      `| ${item.request_index} | ${item.debug_source || ""} | ${item.claude_agent_id || ""} | ${item.response_message_id || ""} | ${item.roles.join(" -> ")} | ${item.tools_count} | ${item.tool_call_names.join(",") || "none"} | ${item.response_tool_call_names.join(",") || "none"} | ${item.finish_reason || ""} | ${item.subagent_markers.map((marker) => marker.kind).join(",") || "none"} | ${oneLine(item.latest_user_preview, 90)} | ${oneLine(item.response_text_preview, 90)} |`,
    );
  }
  lines.push("");
  if (traceObservation.child_agent_instances.length) {
    lines.push("## 子 Agent 请求/回复链");
    lines.push("");
    for (const instance of traceObservation.child_agent_instances) {
      lines.push(`### ${instance.label}: \`${instance.agent_id}\``);
      lines.push("");
      for (const request of instance.requests) {
        const responseCalls = request.response_tool_calls.map((call) => `${call.name}:${call.id}`).join(", ") || "none";
        lines.push(`- request ${request.request_index} -> response ${request.response_message_id || "unknown"}；finish=${request.finish_reason || "unknown"}；response tool calls=${responseCalls}；request tool results=${request.request_tool_results.join(", ") || "none"}`);
      }
      lines.push("");
    }
  }
  lines.push("## 初步结论");
  lines.push("");
  for (const finding of traceObservation.initial_findings) lines.push(`- ${finding}`);
  if (!traceObservation.initial_findings.length) lines.push("- 暂无强结论；需要检查 raw evidence，或用更强的子 Agent 触发 prompt 重跑。");
  lines.push("");
  lines.push("## 父子关系与 turn 信号");
  lines.push("");
  for (const item of captures) {
    lines.push(`### Request ${item.request_index}`);
    lines.push("");
    lines.push(`- turn 候选：${item.turn_link_candidates.map((entry) => `${entry.kind}:${entry.value}`).join(", ") || "none"}`);
    lines.push(`- 父子候选：${item.parent_link_candidates.map((entry) => `${entry.kind}:${entry.tool || entry.value || ""}`).join(", ") || "none"}`);
    lines.push(`- 展示提示：${item.presentation_notes.join(" ") || "none"}`);
    lines.push("");
  }
  lines.push("## Claude stdout 摘要");
  lines.push("");
  lines.push("```text");
  lines.push(preview(stdout || "(Claude Code 未启动。)", 1600));
  lines.push("```");
  lines.push("");
  lines.push("## 下一步问题");
  lines.push("");
  lines.push("- 本次运行产生的是真实子 Agent 请求，还是仅仅是长工具链？");
  lines.push("- 哪些 request 边界适合转成用户可见边界？");
  lines.push("- 能否用 response tool calls 和下一条 request 中的 tool results 重建因果关系？");
  lines.push("- Claude Code 暴露的信息是否足够区分多个同类型子 Agent？");
  lines.push("");
  writeText(reportPath, lines.join("\n"));
}

function parseDebugApiSources(debugFile) {
  if (!fs.existsSync(debugFile)) return [];
  const rows = [];
  for (const line of fs.readFileSync(debugFile, "utf8").split("\n")) {
    const match = line.match(/^(\S+).*?\[API REQUEST\]\s+(\S+)\s+source=(\S+)/);
    if (match) rows.push({ timestamp: match[1], path: match[2], source: match[3] });
  }
  return rows;
}

function listRequestFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.endsWith(".request.json")).sort().map((name) => path.join(root, name));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`);
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part?.text) return part.text;
        if (part?.thinking) return part.thinking;
        if (part?.content) return contentText(part.content);
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content.text) return content.text;
  if (content.content) return contentText(content.content);
  return JSON.stringify(content);
}

function latestMessageText(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return contentText(messages[index].content);
  }
  return "";
}

function extractToolCallsFromMessages(messages) {
  const calls = [];
  for (const message of messages || []) {
    if (Array.isArray(message?.tool_calls)) calls.push(...normalizeOpenAiToolCalls(message.tool_calls));
    if (Array.isArray(message?.content)) calls.push(...extractToolCallsFromContent(message.content));
  }
  return dedupeToolCalls(calls);
}

function extractToolCallsFromContent(content) {
  const calls = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "tool_use") calls.push({ id: part.id || null, name: part.name || "unknown", arguments: part.input ?? null });
    if (Array.isArray(part?.tool_calls)) calls.push(...normalizeOpenAiToolCalls(part.tool_calls));
  }
  return calls;
}

function normalizeOpenAiToolCalls(toolCalls) {
  return (toolCalls || []).map((call) => ({
    id: call.id || null,
    name: call.function?.name || call.name || "unknown",
    arguments: parseMaybeJson(call.function?.arguments) ?? call.function?.arguments ?? call.input ?? null,
  }));
}

function extractToolResultsFromMessages(messages) {
  const results = [];
  for (const message of messages || []) {
    if (message?.role === "tool") results.push({ id: message.tool_call_id || message.id || null, content: contentText(message.content) });
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === "tool_result") results.push({ id: part.tool_use_id || part.id || null, content: contentText(part.content) });
      }
    }
  }
  return results;
}

function dedupeToolCalls(calls) {
  const seen = new Set();
  const output = [];
  for (const call of calls || []) {
    const key = `${call.id || ""}:${call.name}:${stableJson(call.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(call);
  }
  return output;
}

function parseSseEvents(text) {
  const events = [];
  let current = { event: null, data: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
      current = { event: null, data: [] };
      continue;
    }
    if (line.startsWith("event:")) current.event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) current.data.push(line.slice("data:".length).trim());
  }
  if (current.event || current.data.length) events.push({ event: current.event, data: current.data.join("\n") });
  return events;
}

function countSystem(body) {
  if (Array.isArray(body.system)) return body.system.length;
  if (body.system) return 1;
  return 0;
}

function headerValue(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function formatCounts(counts) {
  return Object.entries(counts || {}).map(([key, value]) => `${key}=${value}`).join(", ") || "none";
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function preview(value, limit) {
  const text = String(value || "").replace(/\s+\n/g, "\n").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function oneLine(value, limit) {
  return preview(value, limit).replace(/\s+/g, " ").replaceAll("|", "\\|");
}

function markerPreview(value) {
  const text = String(value || "");
  const match = text.match(/\[(Subagent Context|Subagent Task)\][\s\S]{0,160}/i);
  return match ? oneLine(match[0], 180) : oneLine(text, 180);
}

function bodyTextHasSubagentMarker(value) {
  return /\[Subagent Context\]|\[Subagent Task\]/i.test(String(value || ""));
}

function appendPath(baseUrl, suffix) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const suffixPath = String(suffix || "").startsWith("/") ? suffix : `/${suffix}`;
  base.pathname = `${basePath}${suffixPath}`;
  base.search = "";
  return base.toString();
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function sanitizePreview(value, limit) {
  return preview(value, limit).replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
