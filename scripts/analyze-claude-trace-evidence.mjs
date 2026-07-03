#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const configuredSamples = [
  {
    id: "claude-trace-clarity-live",
    title: "Claude Code trace clarity live 实验",
    dir: "tmp/trace-clarity/claude-code-trace-clarity-exp1/latest",
    optional: true,
  },
  {
    id: "claude-subagent-proxy",
    title: "Claude Code 子 Agent proxy smoke",
    dir: "tmp/smoke-evidence/claude-subagent-proxy/latest",
  },
  {
    id: "claude-proxy-resume",
    title: "Claude Code proxy resume smoke",
    dir: "tmp/smoke-evidence/claude-proxy-resume/latest",
  },
];
const samples = configuredSamples.filter((sample) => sampleUsable(sample));
const outDir = path.join(root, "tmp", "trace-clarity", "claude-evidence-review", "latest");
const observationPath = path.join(outDir, "trace-observation.json");
const reportPath =
  process.env.PEEK_TRACE_CLARITY_CLAUDE_STRUCTURED_OBSERVATION_REPORT ||
  path.join(root, "tmp", "trace-clarity-claude-structured-observation", "trace-clarity-claude-structured-observation.md");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });

function main() {
  if (!samples.length) throw new Error("No usable Claude Code trace evidence samples found.");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const analyses = samples.map(analyzeSample);
  const observation = {
    generated_at: new Date().toISOString(),
    purpose: "Structured Agent Trace observation from existing successful Claude Code proxy evidence.",
    source_note: "This artifact intentionally avoids full raw request bodies; inspect tmp/smoke-evidence locally when raw evidence is needed.",
    samples: analyses,
    cross_sample_findings: crossSampleFindings(analyses),
    presentation_model: buildPresentationModel(analyses),
  };
  writeJson(observationPath, observation);
  writeReport(observation);
  console.log(`Wrote ${observationPath}`);
  console.log(`Wrote ${reportPath}`);
  console.log(
    JSON.stringify(
      {
        samples: analyses.length,
        requests: analyses.reduce((sum, sample) => sum + sample.request_count, 0),
        child_requests: analyses.reduce((sum, sample) => sum + sample.child_request_count, 0),
      },
      null,
      2,
    ),
  );
}

function sampleUsable(sample) {
  const sampleDir = path.join(root, sample.dir);
  if (!fs.existsSync(path.join(sampleDir, "proxy-captures.json")) || !fs.existsSync(path.join(sampleDir, "debug-api-sources.json"))) {
    if (sample.optional) return false;
    throw new Error(`Missing evidence files for ${sample.id}: ${sample.dir}`);
  }
  if (sample.optional) {
    const captures = readJson(path.join(sampleDir, "proxy-captures.json"));
    return Array.isArray(captures) && captures.length > 0;
  }
  return true;
}

function analyzeSample(sample) {
  const sampleDir = path.join(root, sample.dir);
  const captures = readJson(path.join(sampleDir, "proxy-captures.json"));
  const debugSources = readJson(path.join(sampleDir, "debug-api-sources.json"));
  const requests = captures.map((capture, index) => analyzeCapture(capture, debugSources[index], index + 1));
  const lanes = buildLanes(requests);
  return {
    id: sample.id,
    title: sample.title,
    evidence_dir: sample.dir,
    request_count: requests.length,
    child_request_count: requests.filter((request) => request.actor_type === "child").length,
    parent_request_count: requests.filter((request) => request.actor_type === "main").length,
    side_request_count: requests.filter((request) => request.actor_type === "side").length,
    unique_watch_ids: [...new Set(requests.map((request) => request.watch_id).filter(Boolean))],
    unique_conversation_ids: [...new Set(requests.map((request) => request.conversation_id).filter(Boolean))],
    unique_claude_session_prefixes: [...new Set(requests.map((request) => request.claude_session_prefix).filter(Boolean))],
    unique_claude_agent_ids: [...new Set(requests.map((request) => request.claude_agent_id).filter(Boolean))],
    debug_source_counts: countBy(requests.map((request) => request.debug_source || "unknown")),
    lanes,
    child_agent_instances: childAgentInstances(requests),
    requests,
    findings: sampleFindings(requests),
  };
}

function analyzeCapture(capture, debugSource, index) {
  const body = capture.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const requestToolCalls = extractToolCalls(messages);
  const toolResults = extractToolResults(messages);
  const latestUser = latestMessageText(messages, "user");
  const debug = debugSource?.source || null;
  const actorType = classifyActor(debug);
  const toolNames = requestToolCalls.map((tool) => tool.name);
  const resultNames = inferToolResultNames(requestToolCalls, toolResults);
  return {
    request_index: Number(capture.request_index || index),
    status: capture.response?.status || capture.upstream_status || null,
    debug_source: debug,
    actor_type: actorType,
    actor_label: actorLabel(debug, actorType),
    watch_id: capture.watch_id || null,
    conversation_id: capture.conversation_id || null,
    claude_session_prefix: headerValue(capture.headers, "x-claude-code-session-id").slice(0, 12) || null,
    claude_agent_id: headerValue(capture.headers, "x-claude-code-agent-id") || null,
    path: capture.path || null,
    model: body.model || null,
    messages_count: messages.length,
    system_count: countSystem(body),
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    latest_user_hash: latestUser ? sha(latestUser).slice(0, 12) : null,
    latest_user_preview: oneLine(latestUser, 120),
    request_tool_calls: requestToolCalls.map((tool) => ({
      id: tool.id,
      name: tool.name,
      arguments_preview: oneLine(stableJson(tool.arguments), 180),
    })),
    tool_results: toolResults.map((result) => ({
      id: result.id,
      tool_name_guess: resultNames.get(result.id) || null,
      preview: oneLine(result.content, 140),
    })),
    trace_role: classifyTraceRole({ debug, actorType, toolNames, toolResultCount: toolResults.length }),
    grouping_signals: groupingSignals({ debug, actorType, toolNames, toolResults, capture }),
  };
}

function buildLanes(requests) {
  return [
    {
      lane: "main",
      label: "主 Agent",
      requests: requests.filter((request) => request.actor_type === "main").map((request) => request.request_index),
    },
    {
      lane: "child",
      label: "子 Agent 分支",
      requests: requests.filter((request) => request.actor_type === "child").map((request) => request.request_index),
    },
    {
      lane: "side",
      label: "旁路请求",
      requests: requests.filter((request) => request.actor_type === "side").map((request) => request.request_index),
    },
  ].filter((lane) => lane.requests.length);
}

function childAgentInstances(requests) {
  const groups = new Map();
  for (const request of requests) {
    if (!request.claude_agent_id) continue;
    if (!groups.has(request.claude_agent_id)) groups.set(request.claude_agent_id, []);
    groups.get(request.claude_agent_id).push(request.request_index);
  }
  return [...groups.entries()].map(([agent_id, request_indexes], index) => ({
    label: `子 Agent ${index + 1}`,
    agent_id,
    request_indexes,
  }));
}

function sampleFindings(requests) {
  const findings = [];
  if (requests.some((request) => request.actor_type === "child")) {
    findings.push("debug source 会把子 Agent 请求暴露为 `agent:*` 条目。");
  }
  if (new Set(requests.map((request) => request.claude_session_prefix).filter(Boolean)).size <= 1) {
    findings.push("Claude session id 是稳定的会话信号，但不能区分父请求和子请求。");
  }
  if (requests.some((request) => request.claude_agent_id)) {
    findings.push("`x-claude-code-agent-id` 可稳定区分不同子 Agent 实例，并把同一子 Agent 的多轮请求串起来。");
  }
  if (requests.some((request) => request.request_tool_calls.some((tool) => tool.name === "Agent"))) {
    findings.push("父请求历史中包含 `Agent` 工具调用/结果，可用于把子分支接回主线。");
  }
  if (requests.some((request) => request.tool_results.length)) {
    findings.push("`tool_result` 数量可识别同一用户 turn 内的模型续写请求。");
  }
  return findings;
}

function crossSampleFindings(analyses) {
  const requests = analyses.flatMap((sample) => sample.requests);
  const findings = [];
  const childCount = requests.filter((request) => request.actor_type === "child").length;
  const mainWithAgent = requests.filter((request) => request.request_tool_calls.some((tool) => tool.name === "Agent")).length;
  const childInstanceCount = new Set(requests.map((request) => request.claude_agent_id).filter(Boolean)).size;
  findings.push(`在 ${analyses.length} 组成功 evidence 中共观察到 ${childCount} 个子 Agent 请求。`);
  findings.push(`观察到 ${childInstanceCount} 个不同的 Claude Code 子 Agent 实例 ID，可用于区分同类型子 Agent。`);
  findings.push(`观察到 ${mainWithAgent} 个带有 Agent 工具历史的父请求，可承载子 Agent 结果回流边。`);
  findings.push("request 边界只是 raw evidence 边界；用户可见 turn 边界需要结合用户输入 hash、工具续写和 actor 角色推断。");
  findings.push("标题生成应作为旁路请求展示，而不是正常 Agent 推理步骤。");
  return findings;
}

function buildPresentationModel(analyses) {
  return {
    top_level_group: "recording/watch",
    turn_group_candidates: ["latest_user_hash", "conversation_id", "tool_result_continuation"],
    actor_lanes: ["主 Agent", "子 Agent 分支", "旁路请求"],
    child_detection: [
      { signal: "x-claude-code-agent-id", confidence: "high" },
      { signal: "debug_source starts with agent:", confidence: "high" },
      { signal: "parent Agent tool_use/tool_result history", confidence: "medium" },
      { signal: "tool inventory differs from main agent", confidence: "low" },
    ],
    default_ui: "把子 Agent 请求作为父用户 turn 内的可折叠分支展示，同时保留 raw request card 供用户检查。",
    sample_ids: analyses.map((sample) => sample.id),
  };
}

function classifyActor(debugSource) {
  if (debugSource?.startsWith("agent:")) return "child";
  if (debugSource === "generate_session_title") return "side";
  return "main";
}

function actorLabel(debugSource, actorType) {
  if (actorType === "child") return debugSource.replace(/^agent:/, "") + " 子 Agent";
  if (actorType === "side") return "会话标题";
  return "主 Agent";
}

function classifyTraceRole({ debug, actorType, toolNames, toolResultCount }) {
  if (debug === "generate_session_title") return "session_title_side_request";
  if (actorType === "child" && toolResultCount > 0) return "child_tool_continuation";
  if (actorType === "child") return "child_start";
  if (toolNames.includes("Agent") && toolResultCount > 0) return "parent_after_child_return";
  if (toolResultCount > 0) return "main_tool_continuation";
  return "main_start";
}

function groupingSignals({ debug, actorType, toolNames, toolResults, capture }) {
  const signals = [];
  if (debug) signals.push({ name: "debug_source", value: debug, confidence: debug.startsWith("agent:") ? "high" : "medium" });
  const sessionId = headerValue(capture.headers, "x-claude-code-session-id");
  if (sessionId) signals.push({ name: "claude_session_id", value: sessionId.slice(0, 12), confidence: "low" });
  if (actorType === "child") signals.push({ name: "child_actor", value: "debug_source agent:*", confidence: "high" });
  if (toolNames.includes("Agent")) signals.push({ name: "parent_child_return", value: "Agent tool history", confidence: "medium" });
  if (toolResults.length) signals.push({ name: "tool_result_continuation", value: String(toolResults.length), confidence: "medium" });
  return signals;
}

function extractToolCalls(messages) {
  const calls = [];
  for (const message of messages) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === "tool_use") calls.push({ id: part.id || null, name: part.name || "unknown", arguments: part.input ?? null });
    }
  }
  return calls;
}

function extractToolResults(messages) {
  const results = [];
  for (const message of messages) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === "tool_result") results.push({ id: part.tool_use_id || part.id || null, content: contentText(part.content) });
    }
  }
  return results;
}

function inferToolResultNames(toolCalls, toolResults) {
  const byId = new Map(toolCalls.map((tool) => [tool.id, tool.name]));
  const names = new Map();
  for (const result of toolResults) {
    if (byId.has(result.id)) names.set(result.id, byId.get(result.id));
  }
  return names;
}

function latestMessageText(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) return contentText(messages[index].content);
  }
  return "";
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
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content.text) return content.text;
  if (content.content) return contentText(content.content);
  return "";
}

function writeReport(observation) {
  const lines = [];
  lines.push("# Claude Code 结构化 Trace 观察");
  lines.push("");
  lines.push(`生成时间：${observation.generated_at}`);
  lines.push("");
  lines.push("用途：把成功的 Claude Code proxy evidence 转成可复验的结构化观察结果，用于 trace clarity 设计。");
  lines.push("");
  lines.push("## 跨样本结论");
  lines.push("");
  for (const finding of observation.cross_sample_findings) lines.push(`- ${finding}`);
  lines.push("");
  lines.push("## 样本");
  lines.push("");
  for (const sample of observation.samples) {
    lines.push(`### ${sample.title}`);
    lines.push("");
    lines.push(`- evidence：\`${sample.evidence_dir}\``);
    lines.push(`- 请求数：${sample.request_count}`);
    lines.push(`- 主 Agent / 子 Agent / 旁路请求：${sample.parent_request_count} / ${sample.child_request_count} / ${sample.side_request_count}`);
    lines.push(`- debug source：${formatCounts(sample.debug_source_counts)}`);
    lines.push(`- 轨道：${sample.lanes.map((lane) => `${lane.label} [${lane.requests.join(", ")}]`).join("；")}`);
    if (sample.child_agent_instances.length) {
      lines.push(`- 子 Agent 实例：${sample.child_agent_instances.map((agent) => `${agent.label}=${agent.agent_id} [${agent.request_indexes.join(", ")}]`).join("；")}`);
    }
    lines.push("");
    lines.push("| # | actor | agent id | trace 角色 | messages | tools | 工具调用 | 工具结果 | status |");
    lines.push("| ---: | --- | --- | --- | ---: | ---: | --- | --- | ---: |");
    for (const request of sample.requests) {
      lines.push(
        `| ${request.request_index} | ${request.actor_label} | ${request.claude_agent_id || ""} | ${zhTraceRole(request.trace_role)} | ${request.messages_count} | ${request.tools_count} | ${request.request_tool_calls.map((tool) => tool.name).join(", ") || "none"} | ${request.tool_results.length || "none"} | ${request.status || ""} |`,
      );
    }
    lines.push("");
    lines.push("结论：");
    for (const finding of sample.findings) lines.push(`- ${finding}`);
    lines.push("");
  }
  lines.push("## 展示模型建议");
  lines.push("");
  lines.push(`- 顶层分组：${observation.presentation_model.top_level_group}`);
  lines.push(`- turn 候选信号：${observation.presentation_model.turn_group_candidates.join(", ")}`);
  lines.push(`- actor 轨道：${observation.presentation_model.actor_lanes.join(", ")}`);
  lines.push(`- 默认 UI：${observation.presentation_model.default_ui}`);
  lines.push("");
  writeText(reportPath, lines.join("\n"));
}

function zhTraceRole(role) {
  return {
    session_title_side_request: "会话标题旁路请求",
    child_tool_continuation: "子 Agent 工具续写",
    child_start: "子 Agent 开始",
    parent_after_child_return: "子 Agent 结果回流后的父请求",
    main_tool_continuation: "主 Agent 工具续写",
    main_start: "主 Agent 开始",
  }[role] || role;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`);
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

function sha(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

function oneLine(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").replaceAll("|", "\\|").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

main();
