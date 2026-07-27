import {
  extractTranslationSchemaDescriptions,
  isSkippableTranslationMaterial,
  normalizeTranslationSourceText,
  systemTranslationKind,
  translationLookupKey,
  translationToolDescription,
} from "./blocks.mjs";
import { extractContentText } from "../trace/content-parts.mjs";
import { extractRequestMessages, extractRequestToolCatalog } from "../shared/request-payload.mjs";
import {
  classifyCodexDeveloperInstruction,
  codexSlashCommandInjection,
  compactInjectionText,
  extractCodexHarnessBlocks,
  isSuggestionModeMessage,
  parseCommandMessage,
  stripCodexHarnessBlocks,
} from "../trace/message-semantics.mjs";

export function projectTranslationBodyMaterials(
  body,
  {
    section = "",
    contentText = extractContentText,
    extractHarnessParts = () => [],
    harnessContext = {},
  } = {},
) {
  const source = body && typeof body === "object" ? body : {};
  const messages = extractRequestMessages(source);
  const materials = [];

  if (!section || section === "system") {
    extractTranslationSystemParts(source, messages, contentText).forEach((part, index) => {
      materials.push({
        kind: systemTranslationKind(part.text),
        source_text: part.text,
        source_language: "en",
        metadata: { source: part.source, index },
      });
    });
  }

  if (!section || section === "harness") {
    for (const part of extractHarnessParts(messages, harnessContext) || []) {
      materials.push({
        kind: part.kind,
        source_text: part.text,
        source_language: "en",
        metadata: {
          label: part.label,
          path: part.path,
          tag: part.tag || null,
          category: part.category || null,
          label_key: part.labelKey || null,
        },
      });
    }
  }

  if (!section || section === "developer") {
    messages.forEach((message, messageIndex) => {
      if (message?.role !== "developer") return;
      const text = contentText(message.content);
      if (!text) return;
      materials.push({
        kind: "developer_instruction",
        source_text: text,
        source_language: "en",
        metadata: { source: "messages.developer", index: messageIndex },
      });
    });
  }

  if (!section || section === "tools") {
    const catalog = extractRequestToolCatalog(source, { includeDefinitions: true });
    const namespaces = new Map(catalog.namespaces.map((namespace) => [namespace.qualified_name, namespace]));
    for (const namespace of catalog.namespaces) {
      const description = translationToolDescription(namespace.definition);
      if (description) {
        materials.push({
          kind: "tool_namespace_description",
          source_text: description,
          source_language: "en",
          metadata: {
            namespace_name: namespace.qualified_name,
            namespace_leaf_name: namespace.name,
            namespace_parent: namespace.namespace,
            namespace_path: namespace.namespace_path,
            namespace_source_path: namespace.source_path,
            namespace_tool_count: namespace.tool_count,
            path: `${namespace.source_path}.description`,
          },
        });
      }
    }
    for (const tool of catalog.tools) {
      const definition = tool.definition || {};
      const namespace = namespaces.get(tool.namespace) || null;
      const metadata = {
        tool_name: tool.qualified_name,
        tool_leaf_name: tool.name,
        tool_namespace: tool.namespace,
        tool_namespace_path: tool.namespace_path,
        tool_source_path: tool.source_path,
        tool_deferred: tool.deferred,
        tool_namespace_tool_count: namespace?.tool_count || null,
      };
      const description = translationToolDescription(definition);
      if (description) {
        materials.push({
          kind: "tool_description",
          source_text: description,
          source_language: "en",
          metadata: {
            ...metadata,
            path: toolDescriptionPath(definition, tool.source_path),
          },
        });
      }
      const { schema, path } = toolSchema(definition, tool.source_path);
      for (const item of extractTranslationSchemaDescriptions(schema, {
        rootPath: path,
      })) {
        materials.push({
          kind: "tool_parameter_description",
          source_text: item.description,
          source_language: "en",
          metadata: { ...metadata, path: item.path, field_name: item.field_name },
        });
      }
    }
  }

  return materials;
}

export function translationMaterialsForRequest(
  request,
  { section = "", contentText = extractContentText, extractHarnessParts = () => [] } = {},
) {
  const body = request?.raw?.body || request?.body || {};
  const harnessContext = harnessContextForRequest(request);
  if (!section) {
    return [
      ...translationMaterialsForRequest(request, { section: "system", contentText, extractHarnessParts }),
      ...translationMaterialsForRequest(request, { section: "developer", contentText, extractHarnessParts }),
      ...translationMaterialsForRequest(request, { section: "tools", contentText, extractHarnessParts }),
      ...translationMaterialsForRequest(request, { section: "harness", contentText, extractHarnessParts }),
      ...translationMaterialsForRequest(request, { section: "response", contentText, extractHarnessParts }),
    ];
  }
  if (section === "response") {
    return dedupeTranslationMaterials(projectTranslationResponseMaterials(request, { contentText }));
  }
  const materials = projectTranslationBodyMaterials(body, {
    section,
    contentText,
    extractHarnessParts,
    harnessContext,
  });
  return section === "tools"
    ? dedupeToolTranslationMaterials(materials)
    : dedupeTranslationMaterials(materials);
}

export function projectTranslationResponseMaterials(request, { contentText = extractContentText } = {}) {
  const extract = requiredFunction(contentText, "contentText");
  const summary = request?.summary?.response || {};
  const output = [];
  appendResponseTranslation(output, "assistant_reasoning", summary.thinking, "summary.response.thinking");
  appendResponseTranslation(output, "assistant_response", summary.text, "summary.response.text");

  const response =
    summary.complete_response ||
    request?.raw?.response?.body_json ||
    request?.response?.body_json ||
    request?.response ||
    null;
  for (const [index, item] of (Array.isArray(response?.output) ? response.output : []).entries()) {
    const type = String(item?.type || "").toLowerCase();
    if (type === "reasoning") {
      appendResponseTranslation(output, "assistant_reasoning", extract(item.summary), `response.output[${index}].summary`);
    } else if (type === "message") {
      appendResponseTranslation(output, "assistant_response", extract(item.content), `response.output[${index}].content`);
    }
  }
  if (Array.isArray(response?.content)) {
    response.content.forEach((item, index) => {
      const type = String(item?.type || "").toLowerCase();
      if (["thinking", "reasoning"].includes(type)) {
        appendResponseTranslation(output, "assistant_reasoning", extract(item), `response.content[${index}]`);
      } else if (["text", "output_text"].includes(type)) {
        appendResponseTranslation(output, "assistant_response", extract(item), `response.content[${index}]`);
      }
    });
  }
  return output;
}

function appendResponseTranslation(output, kind, value, source) {
  const text = normalizeTranslationSourceText(value);
  if (!text) return;
  output.push({
    kind,
    source_text: text,
    source_language: "en",
    metadata: { source },
  });
}

export function extractTranslationSystemParts(body, messages, contentText = extractContentText) {
  const extract = requiredFunction(contentText, "contentText");
  const output = [];
  if (typeof body?.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body?.system)) {
    body.system.forEach((part) => output.push({ source: "body.system", text: extract(part) }));
  }
  if (typeof body?.instructions === "string") output.push({ source: "body.instructions", text: body.instructions });
  if (Array.isArray(body?.instructions)) {
    body.instructions.forEach((part) => output.push({ source: "body.instructions", text: extract(part) }));
  }
  for (const message of messages || []) {
    if (message?.role === "system") output.push({ source: "messages.system", text: extract(message.content) });
  }
  return output.filter((part) => part.text);
}

export function extractHarnessTranslationParts(
  messages,
  {
    contentText = extractContentText,
    labelForPart = defaultHarnessLabel,
    openCodeCommand = null,
  } = {},
) {
  const extract = requiredFunction(contentText, "contentText");
  const label = requiredFunction(labelForPart, "labelForPart");
  const output = [];

  (Array.isArray(messages) ? messages : []).forEach((message, messageIndex) => {
    if (!message || !["user", "developer"].includes(message.role)) return;
    const fullText = extract(message.content);
    const codexBlocks = extractCodexHarnessBlocks(fullText);
    if (message.role === "developer") {
      const developerRemainder = stripCodexHarnessBlocks(fullText);
      const classifiedDeveloper = classifyCodexDeveloperInstruction(developerRemainder);
      if (classifiedDeveloper) {
        output.push(harnessPart(classifiedDeveloper.kind, classifiedDeveloper.text, messageIndex, label, {
          tag: classifiedDeveloper.tag,
          category: classifiedDeveloper.category,
          labelKey: classifiedDeveloper.labelKey,
          defaultLabel: classifiedDeveloper.defaultLabel,
        }));
      }
    }
    for (const [contextIndex, block] of codexBlocks.entries()) {
      output.push(harnessPart(block.kind, block.text, messageIndex, label, {
        contextIndex,
        tag: block.tag,
        category: block.category,
        labelKey: block.labelKey,
        defaultLabel: block.defaultLabel,
      }));
    }
    if (message.role !== "user") return;
    const compact = compactInjectionText(message);
    if (compact) {
      output.push(harnessPart("harness_compact", compact, messageIndex, label));
    }

    const codexSlashInjection = codexSlashCommandInjection(message);
    if (codexSlashInjection) {
      output.push(harnessPart(codexSlashInjection.kind, codexSlashInjection.text, messageIndex, label, {
        command: codexSlashInjection.command,
      }));
    }

    const commandMessage = parseCommandMessage(message);
    if (commandMessage?.body) {
      output.push(harnessPart("harness_command", commandMessage.body, messageIndex, label, {
        command: commandMessage.command,
      }));
    }

    if (isSuggestionModeMessage(message)) {
      output.push(harnessPart("harness_suggestion", fullText, messageIndex, label));
    }

    const reminderRegex = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
    let match;
    let reminderIndex = 0;
    while ((match = reminderRegex.exec(fullText))) {
      const inner = (match[1] || "").trim();
      if (inner) {
        output.push(harnessPart("harness_reminder", inner, messageIndex, label, { reminderIndex }));
      }
      reminderIndex += 1;
    }
  });

  const command = normalizeOpenCodeCommandEvidence(openCodeCommand);
  if (command) {
    const messageIndex = findLastCommandPromptIndex(messages, extract);
    if (messageIndex >= 0) {
      const text = extract(messages[messageIndex]?.content);
      output.push(harnessPart("harness_command", text, messageIndex, label, {
        command: `/${command}`,
        tag: "opencode-command",
        category: "command",
        evidence: "wrapper_cli_argument",
      }));
    }
  }

  return output.filter((part) => part.text);
}

export function dedupeTranslationMaterials(materials) {
  return [
    ...new Map(
      (materials || []).map((item) => {
        const sourceText = normalizeTranslationSourceText(item?.source_text);
        return [
          translationLookupKey(item?.kind, sourceText),
          { ...item, source_text: sourceText },
        ];
      }),
    ).values(),
  ].filter((item) => item.source_text && !isSkippableTranslationMaterial(item.kind, item.source_text));
}

export function dedupeToolTranslationMaterials(materials) {
  return [
    ...new Map(
      (materials || []).map((item) => {
        const sourceText = normalizeTranslationSourceText(item?.source_text);
        const metadata = item?.metadata || {};
        const key = [
          translationLookupKey(item?.kind, sourceText),
          metadata.tool_name || metadata.namespace_name || "unknown",
          metadata.field_name || metadata.path || "",
        ].join("\0");
        return [key, { ...item, source_text: sourceText }];
      }),
    ).values(),
  ].filter((item) => item.source_text && !isSkippableTranslationMaterial(item.kind, item.source_text));
}

function toolDescriptionPath(definition, sourcePath) {
  if (definition?.function?.description != null && definition?.description == null) {
    return `${sourcePath}.function.description`;
  }
  return `${sourcePath}.description`;
}

function toolSchema(definition, sourcePath) {
  if (definition?.input_schema != null) {
    return { schema: definition.input_schema, path: `${sourcePath}.input_schema` };
  }
  if (definition?.function?.parameters != null) {
    return { schema: definition.function.parameters, path: `${sourcePath}.function.parameters` };
  }
  if (definition?.parameters != null) {
    return { schema: definition.parameters, path: `${sourcePath}.parameters` };
  }
  if (definition?.parametersJsonSchema != null) {
    return { schema: definition.parametersJsonSchema, path: `${sourcePath}.parametersJsonSchema` };
  }
  if (definition?.parameters_json_schema != null) {
    return { schema: definition.parameters_json_schema, path: `${sourcePath}.parameters_json_schema` };
  }
  return { schema: null, path: `${sourcePath}.parameters` };
}

function harnessPart(kind, text, messageIndex, labelForPart, details = {}) {
  const reminderIndex = Number.isInteger(details.reminderIndex) ? details.reminderIndex : null;
  const contextIndex = Number.isInteger(details.contextIndex) ? details.contextIndex : null;
  const path = contextIndex != null
    ? `messages[${messageIndex}].codex-context[${contextIndex}]`
    : reminderIndex == null
    ? `messages[${messageIndex}]`
    : `messages[${messageIndex}].system-reminder[${reminderIndex}]`;
  return {
    kind,
    text,
    label: labelForPart(kind, { ...details, messageIndex }),
    path,
    ...details,
  };
}

function defaultHarnessLabel(kind, { command = "", reminderIndex = 0, defaultLabel = "" } = {}) {
  if (kind === "harness_compact") return "compact 压缩指令";
  if (kind === "harness_command") return `命令 ${command}`.trim();
  if (kind === "harness_suggestion") return "Suggestion 模式";
  if (kind === "harness_reminder") return `框架提醒 #${reminderIndex + 1}`;
  if (kind === "harness_developer") return "Codex developer 指令";
  if (kind === "harness_codex_context") return "Codex 上下文注入";
  if (kind.startsWith("harness_codex_") && defaultLabel) return defaultLabel;
  return kind;
}

function harnessContextForRequest(request) {
  const headers = request?.raw?.headers || request?.headers || {};
  return {
    openCodeCommand: caseInsensitiveHeader(headers, "x-peek-opencode-command"),
  };
}

function caseInsensitiveHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function normalizeOpenCodeCommandEvidence(value) {
  const command = String(value || "").trim().replace(/^\/+/, "");
  if (!command || command.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(command)) return null;
  return command;
}

function findLastCommandPromptIndex(messages, contentText) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role !== "user") continue;
    if (contentText(message.content).trim()) return index;
  }
  return -1;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
