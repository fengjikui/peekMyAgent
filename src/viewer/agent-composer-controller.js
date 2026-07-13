import { buildAgentComposerView } from "./agent-composer-model.js";
import { renderAgentComposer } from "./agent-composer-renderer.js";

export class AgentComposerController {
  constructor({
    element,
    sendMessage,
    refreshSource,
    translate,
    escapeHtml,
    projectNameFromWorkspace,
    shortId,
    cleanText,
    shortPreview,
    nextTick = defaultNextTick,
  } = {}) {
    if (!element) throw new Error("element is required");
    if (typeof sendMessage !== "function") throw new Error("sendMessage is required");
    if (typeof refreshSource !== "function") throw new Error("refreshSource is required");
    if (typeof translate !== "function") throw new Error("translate is required");
    if (typeof escapeHtml !== "function") throw new Error("escapeHtml is required");

    this.element = element;
    this.sendMessage = sendMessage;
    this.refreshSource = refreshSource;
    this.translate = translate;
    this.escapeHtml = escapeHtml;
    this.modelDependencies = {
      projectNameFromWorkspace,
      shortId,
      cleanText,
      shortPreview,
    };
    this.nextTick = nextTick;
    this.source = null;
    this.stateBySource = new Map();

    this.handleSubmit = (event) => {
      if (!event.target?.matches?.("[data-agent-compose]")) return;
      event.preventDefault();
      this.submit(this.currentDraft());
    };
    this.handleKeydown = (event) => {
      if (!event.target?.matches?.("textarea[name='message']")) return;
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      this.submit(event.target.value);
    };
    this.handleInput = (event) => {
      if (!event.target?.matches?.("textarea[name='message']")) return;
      const sendState = this.currentState();
      if (sendState) sendState.draft = event.target.value;
    };

    this.element.addEventListener("submit", this.handleSubmit);
    this.element.addEventListener("keydown", this.handleKeydown);
    this.element.addEventListener("input", this.handleInput);
  }

  render(source) {
    this.source = source || null;
    if (!this.source?.id) {
      this.element.innerHTML = "";
      return;
    }
    const view = this.buildView(this.source, this.stateFor(this.source.id));
    this.element.innerHTML = renderAgentComposer(view, { escapeHtml: this.escapeHtml });
  }

  async submit(rawMessage) {
    const message = String(rawMessage || "").trim();
    const sourceId = this.source?.id || "";
    const sendState = sourceId ? this.stateFor(sourceId) : null;
    if (!message || !sourceId || !sendState || !this.buildView(this.source, sendState).enabled) return null;
    let stateSourceId = sourceId;

    sendState.loading = true;
    sendState.error = "";
    sendState.message = this.translate("sentWaitingCapture");
    sendState.result = null;
    sendState.draft = "";
    this.renderCurrentSource(sourceId);
    await this.nextTick();

    let result;
    try {
      result = await this.sendMessage({ source_id: sourceId, message });
    } catch (error) {
      sendState.loading = false;
      sendState.error = error?.message || String(error);
      sendState.message = "";
      sendState.result = null;
      sendState.draft = String(rawMessage || "");
      this.renderCurrentSource(stateSourceId);
      return null;
    }

    const targetSourceId = result?.source_id || sourceId;
    sendState.loading = false;
    sendState.error = "";
    sendState.message = this.translate("sentRefreshingCapture");
    sendState.result = result;
    sendState.draft = "";
    this.moveState(sourceId, targetSourceId, sendState);
    stateSourceId = targetSourceId;
    this.renderCurrentSource(targetSourceId);

    sendState.message = "";
    if (this.source?.id === targetSourceId) {
      try {
        await this.refreshSource(targetSourceId, { preserveScroll: true });
      } catch (error) {
        sendState.error = this.translate("sentRefreshFailed", { message: error?.message || String(error) });
      }
      this.renderCurrentSource(stateSourceId);
    }
    return result;
  }

  buildView(source, sendState) {
    return buildAgentComposerView({
      source,
      sendState,
      translate: this.translate,
      ...this.modelDependencies,
    });
  }

  stateFor(sourceId) {
    if (!this.stateBySource.has(sourceId)) {
      this.stateBySource.set(sourceId, emptySendState());
    }
    return this.stateBySource.get(sourceId);
  }

  currentState() {
    return this.source?.id ? this.stateFor(this.source.id) : null;
  }

  currentDraft() {
    return this.currentState()?.draft || "";
  }

  moveState(sourceId, targetSourceId, sendState) {
    if (!targetSourceId || sourceId === targetSourceId) return;
    this.stateBySource.delete(sourceId);
    this.stateBySource.set(targetSourceId, sendState);
    if (this.source?.id === sourceId) this.source = { ...this.source, id: targetSourceId };
  }

  renderCurrentSource(sourceId) {
    if (this.source?.id === sourceId) this.render(this.source);
  }

  destroy() {
    this.element.removeEventListener("submit", this.handleSubmit);
    this.element.removeEventListener("keydown", this.handleKeydown);
    this.element.removeEventListener("input", this.handleInput);
    this.element.innerHTML = "";
    this.source = null;
    this.stateBySource.clear();
  }
}

function emptySendState() {
  return { loading: false, error: "", message: "", result: null, draft: "" };
}

function defaultNextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
