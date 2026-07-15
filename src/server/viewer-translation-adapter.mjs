import { TranslationMaterialCollector } from "../translation/materials.mjs";
import { extractHarnessTranslationParts } from "../translation/request-materials.mjs";
import { TranslationService } from "../translation/service.mjs";
import { extractContentText } from "../trace/content-parts.mjs";

export { extractHarnessTranslationParts };

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

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object") throw new Error(`${name} is required`);
  return value;
}
