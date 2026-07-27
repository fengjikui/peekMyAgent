export function extractRequestMessages(body = {}) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (!Array.isArray(body?.input)) return [];
  return body.input.map(responseInputItemToMessage).filter(Boolean);
}

export function extractRequestTools(body = {}) {
  const inputTools = Array.isArray(body?.input)
    ? body.input.flatMap((item) =>
        item?.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : [],
      )
    : [];
  const tools = [
    ...(Array.isArray(body?.tools) ? body.tools : []),
    ...(Array.isArray(body?.additional_tools) ? body.additional_tools : []),
    ...inputTools,
  ];
  const seen = new Set();
  return tools.filter((tool) => {
    const key = tool?.name || tool?.function?.name || null;
    if (!key || !seen.has(key)) {
      if (key) seen.add(key);
      return true;
    }
    return false;
  });
}

export function extractRequestToolCatalog(body = {}, { includeDefinitions = false } = {}) {
  const source = body && typeof body === "object" ? body : {};
  const roots = [
    [source.tools, "$.tools"],
    [source.additional_tools, "$.additional_tools"],
  ];
  for (const [inputIndex, item] of (Array.isArray(source.input) ? source.input : []).entries()) {
    if (!item || !["additional_tools", "tool_search_output", "mcp_list_tools"].includes(item.type)) continue;
    roots.push([item.tools, `$.input[${inputIndex}].tools`]);
  }

  const tools = new Map();
  const namespaces = new Map();
  for (const [rootTools, sourcePath] of roots) {
    const catalog = collectToolCatalog(rootTools, { sourcePath, includeDefinitions });
    for (const namespace of catalog.namespaces) namespaces.set(namespace.qualified_name, namespace);
    for (const tool of catalog.tools) tools.set(tool.qualified_name, tool);
  }
  return {
    tools: [...tools.values()],
    namespaces: [...namespaces.values()],
  };
}

export function collectToolCatalog(tools, {
  sourcePath = "$",
  namespacePath = [],
  inheritedDeferred = false,
  includeDefinitions = false,
} = {}) {
  const catalog = { tools: [], namespaces: [] };
  for (const [toolIndex, tool] of (Array.isArray(tools) ? tools : []).entries()) {
    if (!tool || typeof tool !== "object") continue;
    const toolPath = `${sourcePath}[${toolIndex}]`;
    let expanded = false;
    const functionDeclarations = Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations
      : Array.isArray(tool.function_declarations)
        ? tool.function_declarations
        : [];
    if (functionDeclarations.length) {
      const declarationKey = Array.isArray(tool.functionDeclarations)
        ? "functionDeclarations"
        : "function_declarations";
      for (const [declarationIndex, declaration] of functionDeclarations.entries()) {
        if (!declaration || typeof declaration !== "object") continue;
        catalog.tools.push(toolCatalogLeaf(declaration, {
          type: "function",
          sourcePath: `${toolPath}.${declarationKey}[${declarationIndex}]`,
          namespacePath,
          deferred: inheritedDeferred,
          includeDefinitions,
        }));
      }
      expanded = true;
    }
    for (const key of [
      "googleSearch",
      "google_search",
      "codeExecution",
      "code_execution",
      "computerUse",
      "computer_use",
      "urlContext",
      "url_context",
    ]) {
      if (tool[key] == null) continue;
      catalog.tools.push(toolCatalogLeaf({ name: key, definition: tool[key] }, {
        type: "built_in",
        sourcePath: `${toolPath}.${key}`,
        namespacePath,
        deferred: inheritedDeferred,
        includeDefinitions,
      }));
      expanded = true;
    }
    if (expanded) continue;

    const type = normalizedToolType(tool.type) || (tool.function ? "function" : "tool");
    const name = String(tool.name || tool.function?.name || tool.server_label || type || "unknown");
    if (type === "namespace" && Array.isArray(tool.tools)) {
      const nestedNamespacePath = [...namespacePath, name];
      const nestedCatalog = collectToolCatalog(tool.tools, {
        sourcePath: `${toolPath}.tools`,
        namespacePath: nestedNamespacePath,
        inheritedDeferred: inheritedDeferred || Boolean(tool.defer_loading),
        includeDefinitions,
      });
      catalog.namespaces.push({
        name,
        qualified_name: nestedNamespacePath.join("."),
        namespace: namespacePath.join(".") || null,
        namespace_path: nestedNamespacePath,
        source_path: toolPath,
        description_chars: String(tool.description || "").length,
        tool_count: nestedCatalog.tools.length,
        ...(includeDefinitions ? { definition: tool } : {}),
      });
      catalog.namespaces.push(...nestedCatalog.namespaces);
      catalog.tools.push(...nestedCatalog.tools);
      continue;
    }
    catalog.tools.push(toolCatalogLeaf(tool, {
      name,
      type,
      sourcePath: toolPath,
      namespacePath,
      deferred: inheritedDeferred || Boolean(tool.defer_loading),
      includeDefinitions,
    }));
  }
  return catalog;
}

export function responseInputItemToMessage(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "additional_tools") return null;
  if (item.type === "agent_message") {
    return {
      role: "user",
      content: item.content ?? item.text ?? "",
      codex_item_type: "agent_message",
      author: item.author || null,
      recipient: item.recipient || null,
    };
  }
  if (item.role || item.type === "message") {
    return {
      ...item,
      role: item.role || "unknown",
      content: item.content ?? item.text ?? "",
    };
  }
  if (isResponsesToolCallItem(item)) {
    return {
      role: "assistant",
      source_type: item.type,
      content: [{
        type: "tool_use",
        id: item.call_id || item.id || null,
        name: item.name || item.function?.name || responsesToolProtocolName(item.type) || "unknown",
        input: parseMaybeJson(item.arguments ?? item.input ?? item.action ?? item.function?.arguments),
      }],
    };
  }
  if (isResponsesToolOutputItem(item)) {
    return {
      role: "tool",
      source_type: item.type,
      codex_item_type: item.type,
      tool_call_id: item.call_id || item.id || null,
      name: item.name || responsesToolProtocolName(item.type) || null,
      content: item.output ?? item.content ?? item.result ?? item.tools ?? "",
    };
  }
  if (item.type === "reasoning") {
    return {
      role: "assistant",
      source_type: item.type,
      content: [{ type: "reasoning", reasoning: responsesReasoningText(item) }],
    };
  }
  return null;
}

export function isResponsesToolCallItem(item) {
  const type = String(item?.type || "").toLowerCase();
  return Boolean(type && ((type.endsWith("_call") && !type.endsWith("_output")) || type === "program"));
}

export function isResponsesToolOutputItem(item) {
  const type = String(item?.type || "").toLowerCase();
  return Boolean(type && (
    type.endsWith("_call_output") ||
    type === "tool_search_output" ||
    type === "program_output"
  ));
}

export function responsesToolProtocolName(value) {
  const type = String(typeof value === "string" ? value : value?.type || "").toLowerCase();
  const base = type.replace(/_output$/, "").replace(/_call$/, "");
  if (!base || ["function", "custom_tool"].includes(base)) return null;
  return base;
}

function responsesReasoningText(item) {
  const parts = Array.isArray(item?.summary) ? item.summary : [];
  return parts.map((part) => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolCatalogLeaf(tool, {
  name = null,
  type = null,
  sourcePath,
  namespacePath,
  deferred,
  includeDefinitions,
}) {
  const leafName = String(name || tool?.name || tool?.function?.name || "unknown");
  const namespace = namespacePath.join(".") || null;
  return {
    name: leafName,
    qualified_name: namespace ? `${namespace}.${leafName}` : leafName,
    type: type || normalizedToolType(tool?.type) || (tool?.function ? "function" : "tool"),
    namespace,
    namespace_path: [...namespacePath],
    source_path: sourcePath,
    deferred: Boolean(deferred),
    ...(includeDefinitions ? { definition: tool } : {}),
  };
}

function normalizedToolType(value) {
  return String(value || "").trim().toLowerCase();
}
