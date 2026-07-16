import { runTranslationGenerationOperation } from "./translation-generation-operation.js";
import {
  translationActionMaterials,
  translationBlockClipboardText,
  translationGenerationMessage,
  translationSectionClipboardText,
} from "./translation-action-model.js";

const EMPTY_GENERATION_STATE = Object.freeze({ loading: false, error: "", message: "" });

export class TranslationActionController {
  constructor({ getContext, getGenerationState, setGenerationState, cache, data, api, ui } = {}) {
    this.getContext = requiredFunction(getContext, "getContext");
    this.getGenerationState = requiredFunction(getGenerationState, "getGenerationState");
    this.setGenerationState = requiredFunction(setGenerationState, "setGenerationState");
    this.cache = requiredPort(cache, ["captureOperation", "isOperationCurrent", "reload", "isAvailable"], "cache");
    this.data = requiredPort(
      data,
      ["ensureRequestDetail", "requestFor", "sectionMaterials", "sectionStats"],
      "data",
    );
    this.api = requiredPort(api, ["generateTranslations"], "api");
    this.ui = requiredPort(
      ui,
      [
        "translate",
        "translatedTextFor",
        "labelForKind",
        "sectionLabel",
        "copyText",
        "renderRaw",
        "renderTimeline",
        "setTranslationMode",
        "warn",
      ],
      "ui",
    );
    this.sequence = 0;
    this.actions = new Map();
    this.nextActionId = 1;
  }

  get loading() {
    return Boolean(this.getGenerationState()?.loading);
  }

  registerAction({ kind, sourceText, section, requestId = "", surface = "raw", metadata = {}, materials = null } = {}) {
    const id = String(this.nextActionId++);
    this.actions.set(id, {
      kind,
      sourceText,
      section,
      requestId: requestId || this.context().requestId,
      surface,
      metadata,
      materials,
    });
    return id;
  }

  clearActions(surface = "") {
    if (!surface) {
      this.actions.clear();
      this.nextActionId = 1;
      return;
    }
    for (const [id, item] of this.actions.entries()) {
      if (item.surface === surface) this.actions.delete(id);
    }
  }

  copyBlock(actionId, target = null) {
    const item = this.actions.get(String(actionId || ""));
    if (!item) return false;
    const text = translationBlockClipboardText(item, this.modelDependencies());
    this.ui.copyText(text, target);
    return true;
  }

  copySection(section, target = null) {
    const context = this.context();
    const request = this.data.requestFor(context.requestId);
    if (!request) return false;
    const materials = this.data.sectionMaterials(request, section);
    if (!materials.length) return false;
    const text = translationSectionClipboardText(
      {
        section,
        request,
        materials,
        sectionLabel: this.ui.sectionLabel(section),
      },
      this.modelDependencies(),
    );
    if (!text) return false;
    this.ui.copyText(text, target);
    return true;
  }

  invalidate() {
    this.sequence += 1;
    this.setGenerationState({ ...EMPTY_GENERATION_STATE });
  }

  async generateSection(
    section,
    { automatic = false, agent = null, sourceId: expectedSourceId = "", targetLanguage: expectedLanguage = "" } = {},
  ) {
    if (this.loading) return { status: "busy" };
    const context = this.context();
    if (
      (expectedSourceId && expectedSourceId !== context.sourceId) ||
      (expectedLanguage && expectedLanguage !== context.targetLanguage)
    ) {
      return { status: "stale", stage: "context" };
    }
    const activeSection = section || context.activeSection || "system";
    const selectedAgent = agent || context.agent || "Claude Code";
    const operation = this.beginOperation({ ...context, agent: selectedAgent });
    if (!operation) return { status: "unavailable" };

    this.setGenerationState({
      loading: true,
      error: "",
      message: automatic
        ? this.ui.translate("autoTranslating", { language: context.targetLanguageLabel })
        : this.ui.translate("translatingSection"),
    });
    if (context.requestId) this.ui.renderRaw(context.requestId, activeSection, context.rawMode);

    const outcome = await runTranslationGenerationOperation({
      prepare: async () => {
        if (!context.requestId) return;
        try {
          await this.data.ensureRequestDetail(context.requestId);
        } catch (error) {
          this.ui.warn("request detail unavailable before translation", error);
        }
      },
      generate: () =>
        this.api.generateTranslations({
          agent: selectedAgent,
          source_id: context.sourceId,
          request_id: context.requestId,
          section: activeSection,
          force: !automatic,
          target_language: context.targetLanguage,
        }),
      reloadCache: () => this.cache.reload(),
      isCurrent: () => this.isOperationCurrent(operation),
      onStale: () => this.abandon(operation),
      onSuccess: (result) => this.commitSectionSuccess(result, { automatic, context, activeSection }),
      onError: (error) => this.setGenerationState({ loading: false, error: error.message, message: "" }),
    });

    if (
      outcome.status !== "stale" &&
      this.isOperationCurrent(operation) &&
      this.context().requestId === context.requestId
    ) {
      this.ui.renderRaw(context.requestId, activeSection, context.rawMode);
    }
    return outcome;
  }

  async retranslate(actionId) {
    const item = this.actions.get(String(actionId || ""));
    if (!item || this.loading) return { status: item ? "busy" : "missing" };
    const context = this.context();
    const materials = translationActionMaterials(item);
    const operation = this.beginOperation(context);
    if (!operation) return { status: "unavailable" };
    const requestId = item.requestId || context.requestId;

    this.setGenerationState({
      loading: true,
      error: "",
      message:
        materials.length > 1
          ? this.ui.translate("translatingParameterGroup")
          : this.ui.translate("retranslatingBlock"),
    });
    if (item.surface === "raw" && requestId) {
      this.ui.renderRaw(requestId, item.section || context.activeSection || "system", context.rawMode);
    }

    const outcome = await runTranslationGenerationOperation({
      generate: () =>
        this.api.generateTranslations({
          agent: context.agent || "Claude Code",
          source_id: context.sourceId,
          request_id: requestId,
          target_language: context.targetLanguage,
          force: true,
          materials,
        }),
      reloadCache: () => this.cache.reload(),
      isCurrent: () => this.isOperationCurrent(operation),
      onStale: () => this.abandon(operation),
      onSuccess: (result) => {
        const translated = Number(result.translate?.translated || 0);
        this.setGenerationState({
          loading: false,
          error: "",
          message: translated
            ? materials.length > 1
              ? this.ui.translate("retranslatedParametersDone", { count: translated })
              : this.ui.translate("retranslatedBlockDone")
            : this.ui.translate("translationCacheLatest", { language: context.targetLanguageLabel }),
        });
        this.ui.setTranslationMode(context.targetLanguage, { reason: "translation-block-generated" });
      },
      onError: (error) => this.setGenerationState({ loading: false, error: error.message, message: "" }),
    });

    if (outcome.status === "stale" || !this.isOperationCurrent(operation)) return outcome;
    if (item.surface === "timeline") this.ui.renderTimeline();
    else if (item.surface === "raw" && this.context().requestId === requestId) {
      this.ui.renderRaw(requestId, item.section || context.activeSection || "system", context.rawMode);
    }
    return outcome;
  }

  context() {
    const value = this.getContext() || {};
    return {
      sourceId: value.sourceId || "",
      targetLanguage: value.targetLanguage || "",
      targetLanguageLabel: value.targetLanguageLabel || value.targetLanguage || "",
      agent: value.agent || "Claude Code",
      activeSection: value.activeSection || "system",
      requestId: value.requestId || "",
      rawMode: value.rawMode || "request",
    };
  }

  beginOperation(context) {
    const cacheOperation = this.cache.captureOperation({
      sourceId: context.sourceId,
      targetLanguage: context.targetLanguage,
      agent: context.agent,
    });
    if (!cacheOperation) return null;
    return {
      sequence: ++this.sequence,
      cacheOperation,
      sourceId: context.sourceId,
      targetLanguage: context.targetLanguage,
    };
  }

  isOperationCurrent(operation) {
    if (!operation || operation.sequence !== this.sequence) return false;
    const context = this.context();
    return (
      operation.sourceId === context.sourceId &&
      operation.targetLanguage === context.targetLanguage &&
      this.cache.isOperationCurrent(operation.cacheOperation)
    );
  }

  abandon(operation) {
    if (operation?.sequence === this.sequence) this.invalidate();
  }

  commitSectionSuccess(result, { automatic, context, activeSection }) {
    const translated = Number(result.translate?.translated || 0);
    const remaining = Number(result.translate?.remaining || 0);
    const activeRequest = this.data.requestFor(context.requestId);
    const stats = activeRequest
      ? this.data.sectionStats(activeRequest, activeSection)
      : { total: 0, hit: 0, missing: 0 };
    const cacheAvailable = this.cache.isAvailable();
    const message = translationGenerationMessage(
      {
        cacheAvailable,
        translated,
        remaining,
        stats,
        languageLabel: context.targetLanguageLabel,
      },
      { translate: this.ui.translate },
    );
    const latestMessage = this.ui.translate("translationCacheLatest", {
      language: context.targetLanguageLabel,
    });
    this.setGenerationState({
      loading: false,
      error: "",
      message: automatic && message === latestMessage ? this.ui.translate("translationAutoUpdated") : message,
    });
    if (cacheAvailable && stats.hit > 0) {
      this.ui.setTranslationMode(context.targetLanguage, { reason: "translation-generated" });
    }
  }

  modelDependencies() {
    return {
      translatedTextFor: this.ui.translatedTextFor,
      labelForKind: this.ui.labelForKind,
      translate: this.ui.translate,
    };
  }
}

function requiredPort(value, methods, name) {
  if (!value || typeof value !== "object") throw new Error(`${name} port is required`);
  for (const method of methods) requiredFunction(value[method], `${name}.${method}`);
  return value;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
