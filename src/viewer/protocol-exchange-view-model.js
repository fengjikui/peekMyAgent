export function buildProtocolExchangeView(request = {}) {
  const exchange = request?.summary?.protocol_exchange || null;
  if (!exchange) return null;
  const upstream = exchange.request || {};
  const downstream = exchange.response || {};
  const currentInputIndexes = currentProtocolInputIndexes(request, upstream.input_items || []);
  return {
    requestId: request.id || "",
    requestIndex: request.request_index || null,
    model: request.model || request.raw?.body?.model || "",
    protocol: exchange.protocol || request.protocol || "unknown",
    protocolLabel: exchange.protocol_label || exchange.protocol || request.protocol || "Unknown protocol",
    upstream: {
      counts: normalizeCounts(upstream.counts),
      instructions: (upstream.instruction_blocks || []).map((item) => ({
        sourcePath: item.source_path || "",
        role: item.role || "instructions",
        itemType: item.item_type || "text",
        chars: Number(item.chars || 0),
        section: ["developer"].includes(item.role) ? "developer" : "system",
      })),
      toolStages: (upstream.tool_stages || []).map((stage) => ({
        kind: stage.kind || "declared",
        sourcePath: stage.source_path || "",
        inputIndex: Number.isInteger(stage.input_index) ? stage.input_index : null,
        toolCount: Number(stage.tool_count || 0),
        effectiveToolCount: Number(stage.effective_tool_count || 0),
        namespaceCount: Number(stage.namespace_count || 0),
        namespaces: (stage.namespaces || []).map((namespace) => ({
          name: namespace?.name || "unknown",
          qualifiedName: namespace?.qualified_name || namespace?.name || "unknown",
          parentNamespace: namespace?.namespace || "",
          sourcePath: namespace?.source_path || "",
          toolCount: Number(namespace?.tool_count || 0),
        })),
        namespacesOmitted: Number(stage.namespaces_omitted || 0),
        tools: (stage.tools || []).map((tool) => ({
          name: tool?.name || "unknown",
          qualifiedName: tool?.qualified_name || (tool?.namespace ? `${tool.namespace}.${tool?.name || "unknown"}` : tool?.name || "unknown"),
          type: tool?.type || "tool",
          namespace: tool?.namespace || "",
          sourcePath: tool?.source_path || "",
          deferred: Boolean(tool?.deferred),
        })),
        toolsOmitted: Number(stage.tools_omitted || 0),
        section: stage.kind === "loaded" ? "tool_results" : "tools",
      })),
      items: (upstream.input_items || []).map((item) =>
        normalizeProtocolItem(item, {
          direction: "request",
          current: currentInputIndexes.has(item?.index),
        }),
      ),
    },
    downstream: {
      counts: normalizeCounts(downstream.counts),
      status: downstream.status || "",
      items: (downstream.output_items || []).map((item) => normalizeProtocolItem(item, { direction: "response" })),
    },
  };
}

function normalizeProtocolItem(item = {}, { direction = "request", current = false } = {}) {
  const route = protocolItemRoute(item, { direction, current });
  return {
    index: Number.isInteger(item.index) ? item.index : null,
    sourcePath: item.source_path || "",
    itemType: item.item_type || "unknown",
    role: item.role || "unknown",
    semantic: item.semantic || "item",
    chars: Number(item.chars || 0),
    callId: item.call_id || "",
    name: item.name || "",
    toolCount: Number(item.tool_count || 0),
    toolNames: Array.isArray(item.tool_names) ? item.tool_names : [],
    section: route.section,
    mode: route.mode,
  };
}

function currentProtocolInputIndexes(request, items) {
  const messageItems = (Array.isArray(items) ? items : []).filter(
    (item) => !["tools_added", "tools_loaded"].includes(item?.semantic),
  );
  const delta = request?.context_delta || request?.summary?.context_delta || {};
  const count = Number(delta.new_messages);
  if (!Number.isInteger(count) || count <= 0) return new Set();
  return new Set(messageItems.slice(-count).map((item) => item?.index).filter(Number.isInteger));
}

function protocolItemRoute(item, { direction, current }) {
  const semantic = item?.semantic || "";
  const role = item?.role || "";
  if (direction === "response") {
    return semantic === "tool_call" || semantic === "tool_search"
      ? { section: "tool_calls", mode: "response" }
      : { section: "response", mode: "response" };
  }
  if (semantic === "instruction") return { section: role === "developer" ? "developer" : "system", mode: "request" };
  if (semantic === "tools_added") return { section: "tools", mode: "request" };
  if (semantic === "tools_loaded" || semantic === "tool_result") return { section: "tool_results", mode: "request" };
  if (semantic === "tool_call" || semantic === "tool_search") return { section: "upstream_tool_calls", mode: "request" };
  return { section: current ? "message" : "history", mode: "request" };
}

function normalizeCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts && typeof counts === "object" ? counts : {}).map(([key, value]) => [key, Number(value || 0)]),
  );
}
