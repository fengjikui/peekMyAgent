import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { baseNormalizedRequest, collectMessageRedactions, normalizeMessage, requestParams } from "../core/normalize.mjs";
import { safeJsonShape } from "../core/redaction.mjs";
import { createCaptureProvenance } from "../core/provenance.mjs";

export function normalizeClaudeOtelRequestFile(filePath, options = {}) {
  const raw = fs.readFileSync(filePath, "utf8");
  const body = JSON.parse(raw);
  const normalized = normalizeClaudeOtelRequestBody(body, {
    sourcePath: filePath,
    rawSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    deleteRaw: options.deleteRaw === true,
  });
  if (options.deleteRaw === true) fs.rmSync(filePath, { force: true });
  return normalized;
}

export function normalizeClaudeOtelRequestBody(body, options = {}) {
  const systemMessages = normalizeSystem(body.system);
  const messages = Array.isArray(body.messages) ? body.messages.map((message, index) => normalizeMessage(message, index, "body.messages")) : [];
  const params = requestParams(body, ["betas"]);
  if (body.thinking) params.thinking = safeJsonShape(body.thinking);
  if (body.betas) params.betas = safeJsonShape(body.betas);

  const redactions = [
    ...(body.thinking ? [{ field_path: "body.thinking", reason: "extended_thinking_may_be_redacted_by_source" }] : []),
    ...collectMessageRedactions(systemMessages, messages),
  ];

  return baseNormalizedRequest({
    sourceAgent: "Claude Code",
    adapterName: "claude-code-otel-raw-body",
    captureMethod: "otel_raw_body_file",
    captureConfidence: "exact",
    isFinalRemoteRequest: true,
    providerProtocol: "anthropic-messages",
    endpoint: "/v1/messages",
    method: "POST",
    model: body.model,
    system: systemMessages,
    messages,
    tools: body.tools,
    requestParams: params,
    redactions,
    source: {
      type: "otel_raw_body_file",
      path: options.sourcePath || null,
      raw_sha256: options.rawSha256 || null,
      delete_raw_after_read: Boolean(options.deleteRaw),
    },
    provenance: createCaptureProvenance({
      transport: "otel_raw_body_file",
      request: { origin: "agent_telemetry", fidelity: "exact", artifact: options.sourcePath ? path.basename(options.sourcePath) : null },
      response: { origin: null, fidelity: "missing", artifact: null },
      association: { method: "none", confidence: "none" },
    }),
    rawBodyShape: safeJsonShape(body),
  });
}

function normalizeSystem(system) {
  if (!system) return [];
  if (typeof system === "string") {
    return [
      normalizeMessage(
        {
          role: "system",
          content: system,
        },
        0,
        "body.system",
      ),
    ];
  }
  if (Array.isArray(system)) {
    return system.map((content, index) =>
      normalizeMessage(
        {
          role: "system",
          content,
        },
        index,
        "body.system",
      ),
    );
  }
  return [
    normalizeMessage(
      {
        role: "system",
        content: system,
      },
      0,
      "body.system",
    ),
  ];
}
