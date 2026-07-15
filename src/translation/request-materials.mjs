import {
  extractTranslationSchemaDescriptions,
  isSkippableTranslationMaterial,
  normalizeTranslationSourceText,
  systemTranslationKind,
  translationLookupKey,
  translationToolDescription,
  translationToolName,
} from "./blocks.mjs";
import { extractContentText } from "../trace/content-parts.mjs";
import {
  compactInjectionText,
  isSuggestionModeMessage,
  parseCommandMessage,
} from "../trace/message-semantics.mjs";

export function projectTranslationBodyMaterials(
  body,
  { section = "", contentText = extractContentText, extractHarnessParts = () => [] } = {},
) {
  const source = body && typeof body === "object" ? body : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];
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
    for (const part of extractHarnessParts(messages) || []) {
      materials.push({
        kind: part.kind,
        source_text: part.text,
        source_language: "en",
        metadata: { label: part.label, path: part.path },
      });
    }
  }

  if (!section || section === "tools") {
    const tools = Array.isArray(source.tools) ? source.tools : [];
    tools.forEach((tool, toolIndex) => {
      const toolName = translationToolName(tool);
      const description = translationToolDescription(tool);
      if (description) {
        materials.push({
          kind: "tool_description",
          source_text: description,
          source_language: "en",
          metadata: { tool_name: toolName, path: `tools[${toolIndex}].description` },
        });
      }
      const schema = tool.input_schema || tool.function?.parameters || tool.parameters || null;
      for (const item of extractTranslationSchemaDescriptions(schema, {
        rootPath: `tools[${toolIndex}].input_schema`,
      })) {
        materials.push({
          kind: "tool_parameter_description",
          source_text: item.description,
          source_language: "en",
          metadata: { tool_name: toolName, path: item.path, field_name: item.field_name },
        });
      }
    });
  }

  return materials;
}

export function translationMaterialsForRequest(
  request,
  { section = "", contentText = extractContentText, extractHarnessParts = () => [] } = {},
) {
  const body = request?.raw?.body || request?.body || {};
  if (!section) {
    return [
      ...translationMaterialsForRequest(request, { section: "system", contentText, extractHarnessParts }),
      ...translationMaterialsForRequest(request, { section: "tools", contentText, extractHarnessParts }),
      ...translationMaterialsForRequest(request, { section: "harness", contentText, extractHarnessParts }),
    ];
  }
  const materials = projectTranslationBodyMaterials(body, { section, contentText, extractHarnessParts });
  return section === "tools"
    ? dedupeToolTranslationMaterials(materials)
    : dedupeTranslationMaterials(materials);
}

export function extractTranslationSystemParts(body, messages, contentText = extractContentText) {
  const extract = requiredFunction(contentText, "contentText");
  const output = [];
  if (typeof body?.system === "string") output.push({ source: "body.system", text: body.system });
  if (Array.isArray(body?.system)) {
    body.system.forEach((part) => output.push({ source: "body.system", text: extract(part) }));
  }
  for (const message of messages || []) {
    if (message?.role === "system") output.push({ source: "messages.system", text: extract(message.content) });
  }
  return output.filter((part) => part.text);
}

export function extractHarnessTranslationParts(
  messages,
  { contentText = extractContentText, labelForPart = defaultHarnessLabel } = {},
) {
  const extract = requiredFunction(contentText, "contentText");
  const label = requiredFunction(labelForPart, "labelForPart");
  const output = [];

  (Array.isArray(messages) ? messages : []).forEach((message, messageIndex) => {
    if (!message || message.role !== "user") return;
    const fullText = extract(message.content);
    const compact = compactInjectionText(message);
    if (compact) {
      output.push(harnessPart("harness_compact", compact, messageIndex, label));
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
          metadata.tool_name || "unknown",
          metadata.field_name || metadata.path || "",
        ].join("\0");
        return [key, { ...item, source_text: sourceText }];
      }),
    ).values(),
  ].filter((item) => item.source_text && !isSkippableTranslationMaterial(item.kind, item.source_text));
}

function harnessPart(kind, text, messageIndex, labelForPart, details = {}) {
  const reminderIndex = Number.isInteger(details.reminderIndex) ? details.reminderIndex : null;
  const path = reminderIndex == null
    ? `messages[${messageIndex}]`
    : `messages[${messageIndex}].system-reminder[${reminderIndex}]`;
  return {
    kind,
    text,
    label: labelForPart(kind, { ...details, messageIndex }),
    path,
  };
}

function defaultHarnessLabel(kind, { command = "", reminderIndex = 0 } = {}) {
  if (kind === "harness_compact") return "compact 压缩指令";
  if (kind === "harness_command") return `命令 ${command}`.trim();
  if (kind === "harness_suggestion") return "Suggestion 模式";
  if (kind === "harness_reminder") return `框架提醒 #${reminderIndex + 1}`;
  return kind;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
