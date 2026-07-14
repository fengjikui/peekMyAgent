export class RawInspectorController {
  constructor({
    root,
    titleElement,
    getRequest,
    getContext,
    setContext,
    onContextChanged = () => {},
    clearActions = () => {},
    openPanel = () => {},
    needsDetail = () => false,
    loadDetails = async (request) => request,
    titleFor = () => "Raw",
    renderLoading = () => "",
    renderContent,
    renderError,
    decorate = () => {},
    rootClassName = "raw-tree",
  }) {
    if (!root) throw new Error("RawInspectorController root is required");
    if (!titleElement) throw new Error("RawInspectorController titleElement is required");
    if (typeof getRequest !== "function") throw new Error("RawInspectorController getRequest is required");
    if (typeof getContext !== "function") throw new Error("RawInspectorController getContext is required");
    if (typeof setContext !== "function") throw new Error("RawInspectorController setContext is required");
    if (typeof renderContent !== "function") throw new Error("RawInspectorController renderContent is required");
    if (typeof renderError !== "function") throw new Error("RawInspectorController renderError is required");
    this.root = root;
    this.titleElement = titleElement;
    this.getRequest = getRequest;
    this.getContext = getContext;
    this.setContext = setContext;
    this.onContextChanged = onContextChanged;
    this.clearActions = clearActions;
    this.openPanel = openPanel;
    this.needsDetail = needsDetail;
    this.loadDetails = loadDetails;
    this.titleFor = titleFor;
    this.renderLoading = renderLoading;
    this.renderContent = renderContent;
    this.renderError = renderError;
    this.decorate = decorate;
    this.rootClassName = rootClassName;
    this.operationId = 0;
  }

  async show(requestId, section = "full", { mode = "request" } = {}) {
    const request = this.getRequest(requestId);
    if (!request) return false;
    const next = {
      requestId,
      section: section || "full",
      mode: mode || "request",
    };
    const contextChanged = !sameRawContext(this.getContext(), next);
    const operationId = ++this.operationId;
    if (contextChanged) this.onContextChanged();
    this.clearActions();
    this.setContext(next);
    this.openPanel();
    this.titleElement.textContent = this.titleFor(request, next.section, next.mode);
    this.root.className = this.rootClassName;
    if (this.needsDetail(request)) {
      this.root.innerHTML = this.renderLoading(request, next.section, next.mode);
    }
    try {
      const hydrated = await this.loadDetails(request, next.section, next.mode);
      if (!this.isCurrent(operationId, next)) return false;
      this.root.innerHTML = this.renderContent(hydrated, next.section, next.mode);
      this.decorate();
      return true;
    } catch (error) {
      if (!this.isCurrent(operationId, next)) return false;
      this.root.innerHTML = this.renderError(error, request, next.section, next.mode);
      return false;
    }
  }

  refresh() {
    const context = this.getContext();
    if (!context?.requestId) return Promise.resolve(false);
    return this.show(context.requestId, context.section || "full", { mode: context.mode || "request" });
  }

  invalidate() {
    this.operationId += 1;
  }

  isCurrent(operationId, expected) {
    return operationId === this.operationId && sameRawContext(this.getContext(), expected);
  }
}

function sameRawContext(current, expected) {
  return (
    current?.requestId === expected.requestId &&
    current?.section === expected.section &&
    (current?.mode || "request") === expected.mode
  );
}
