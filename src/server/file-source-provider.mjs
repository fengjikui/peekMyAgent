import fs from "node:fs";
import path from "node:path";

export const DEFAULT_FILE_SOURCES = Object.freeze([
  {
    id: "openclaw-subagent",
    label: "OpenClaw 子代理",
    agent: "OpenClaw",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/openclaw-subagent/latest",
    note: "provider baseUrl proxy 捕获；包含主代理与子代理请求。",
  },
  {
    id: "openclaw-multiturn",
    label: "OpenClaw 多轮会话",
    agent: "OpenClaw",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/openclaw-multiturn/latest",
    note: "同一个 session-key 的多轮请求与工具结果回传。",
  },
  {
    id: "claude-subagent",
    label: "Claude Code 子代理",
    agent: "Claude Code",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/claude-subagent-proxy/latest",
    note: "ANTHROPIC_BASE_URL proxy 捕获；含主 Agent 与 Explore 子代理请求。",
  },
  {
    id: "claude-proxy-resume",
    label: "Claude Code proxy resume",
    agent: "Claude Code",
    confidence: "exact",
    kind: "proxy_capture",
    path: "tmp/smoke-evidence/claude-proxy-resume/latest",
    note: "ANTHROPIC_BASE_URL proxy 捕获；同一 session-id/resume 会话，含 Explore 子代理请求。",
  },
]);

export function listFileSources({ cwd, demo, evidencePath, includeStats = true, summarizeDirectory, definitions = DEFAULT_FILE_SOURCES } = {}) {
  const root = path.resolve(cwd || ".");
  if (evidencePath) {
    const absPath = path.resolve(root, evidencePath);
    return [
      {
        id: "custom",
        label: path.basename(absPath),
        agent: "Custom",
        confidence: "unknown",
        kind: "proxy_capture",
        path: absPath,
        available: hasCaptureFile(absPath),
        note: "用户指定的证据目录。",
        ...(includeStats ? summarize(absPath, summarizeDirectory) : {}),
      },
    ];
  }
  if (!demo) return [];
  return definitions.map((source) => {
    const absPath = path.resolve(root, source.path);
    return {
      ...source,
      path: absPath,
      available: hasCaptureFile(absPath),
      ...(includeStats ? summarize(absPath, summarizeDirectory) : {}),
    };
  });
}

function summarize(dir, summarizeDirectory) {
  if (typeof summarizeDirectory !== "function") return {};
  const stats = summarizeDirectory(dir);
  return stats && typeof stats === "object" ? stats : {};
}

function hasCaptureFile(dir) {
  return fs.existsSync(path.join(dir, "proxy-captures.json"));
}
