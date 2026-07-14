import { TranslationMaterialCollector } from "../translation/materials.mjs";
import { TranslationService } from "../translation/service.mjs";
import { extractContentText } from "../trace/content-parts.mjs";
import {
  compactInjectionText,
  isSuggestionModeMessage,
  parseCommandMessage,
} from "../trace/message-semantics.mjs";

export function createViewerTranslationAdapter(options) {
  return new ViewerTranslationAdapter(options);
}

export class ViewerTranslationAdapter {
  constructor({
    projectRoot,
    loadViewerData,
    loadRequestDetail,
    sanitize,
    slugify,
    tooLarge,
    serviceFactory,
  } = {}) {
    this.loadViewerData = requiredFunction(loadViewerData, "loadViewerData");
    this.loadRequestDetail = requiredFunction(loadRequestDetail, "loadRequestDetail");
    this.tooLarge = typeof tooLarge === "function" ? tooLarge : (message) => new Error(message);

    const createService = typeof serviceFactory === "function"
      ? serviceFactory
      : (serviceOptions) => new TranslationService(serviceOptions);
    this.service = requiredObject(
      createService({
        projectRoot,
        materialProvider: {
          fromSource: (input) => this.collectFromSource(input),
          fromInput: (input) => this.collectFromInput(input),
        },
        sanitize,
        slugify,
      }),
      "translation service",
    );
  }

  loadPublicCache(input) {
    return requiredFunction(this.service.loadPublicCache, "translationService.loadPublicCache").call(this.service, input);
  }

  generate(input) {
    return requiredFunction(this.service.generate, "translationService.generate").call(this.service, input);
  }

  collectFromSource({ sourceId, requestId, section, targetLanguage }) {
    const collector = this.createCollector(targetLanguage);
    if (requestId) {
      const detail = this.loadRequestDetail({ sourceId, requestId, requireSource: true });
      collector.collectRequest(detail.request, detail.source, { section });
    } else {
      const data = this.loadViewerData({ sourceId, requireSource: true });
      for (const request of data.requests || []) collector.collectRequest(request, data.source, { section });
    }
    return { materials: collector.materials(), sourceCount: 1 };
  }

  collectFromInput({ materials, sourceId, requestId, targetLanguage }) {
    const collector = this.createCollector(targetLanguage);
    collector.collectInput(materials, {
      source_id: sourceId || null,
      watch_id: null,
      request_id: requestId || null,
      request_index: null,
      workspace: null,
      conversation_id: null,
    });
    return { materials: collector.materials(), sourceCount: sourceId ? 1 : 0 };
  }

  createCollector(targetLanguage) {
    return new TranslationMaterialCollector({
      targetLanguage,
      contentText: extractContentText,
      extractHarnessParts: extractHarnessTranslationParts,
      tooLarge: this.tooLarge,
    });
  }
}

// Harness prompts live inside the upstream message stack but are injected by
// the Agent runtime. Keeping their extraction here prevents the HTTP assembly
// layer and the browser renderer from growing separate message heuristics.
export function extractHarnessTranslationParts(messages) {
  const output = [];
  const reminderRegex = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi;
  (Array.isArray(messages) ? messages : []).forEach((message, messageIndex) => {
    if (!message || message.role !== "user") return;
    const fullText = extractContentText(message.content);

    const compact = compactInjectionText(message);
    if (compact) {
      output.push({ kind: "harness_compact", text: compact, label: "compact 压缩指令", path: `messages[${messageIndex}]` });
    }

    const commandMessage = parseCommandMessage(message);
    if (commandMessage?.body) {
      output.push({ kind: "harness_command", text: commandMessage.body, label: `命令 ${commandMessage.command}`, path: `messages[${messageIndex}]` });
    }

    if (isSuggestionModeMessage(message)) {
      output.push({ kind: "harness_suggestion", text: fullText, label: "Suggestion 模式", path: `messages[${messageIndex}]` });
    }

    let match;
    let reminderIndex = 0;
    while ((match = reminderRegex.exec(fullText))) {
      const inner = (match[1] || "").trim();
      if (inner) {
        output.push({ kind: "harness_reminder", text: inner, label: `框架提醒 #${reminderIndex + 1}`, path: `messages[${messageIndex}].system-reminder[${reminderIndex}]` });
      }
      reminderIndex += 1;
    }
  });
  return output.filter((part) => part.text);
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object") throw new Error(`${name} is required`);
  return value;
}
