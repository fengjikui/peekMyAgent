export class TraceTimelineController {
  constructor({
    queryElement,
    timelineElement,
    onQueryChange,
    onRenderRequested,
    onFilter,
    onShowMore,
    onResponseToggle,
    onUpstreamToggle,
    onUpstreamPanelToggle,
    onThinkingToggle = () => {},
    onTurnWindowJump,
    onRaw,
    onToolOriginJump = () => {},
    onRequestJump,
    onAgentJump,
    onAgentBranchJump,
    onAgentBranchSelect = () => {},
    onSupportingTimelineToggle,
    onSystemDiff,
    searchDelay = 160,
    windowRef = globalThis.window,
  } = {}) {
    this.queryElement = requiredElement(queryElement, "queryElement");
    this.timelineElement = requiredElement(timelineElement, "timelineElement");
    this.onQueryChange = requiredFunction(onQueryChange, "onQueryChange");
    this.onRenderRequested = requiredFunction(onRenderRequested, "onRenderRequested");
    this.onFilter = requiredFunction(onFilter, "onFilter");
    this.onShowMore = requiredFunction(onShowMore, "onShowMore");
    this.onResponseToggle = requiredFunction(onResponseToggle, "onResponseToggle");
    this.onUpstreamToggle = requiredFunction(onUpstreamToggle, "onUpstreamToggle");
    this.onUpstreamPanelToggle = requiredFunction(onUpstreamPanelToggle, "onUpstreamPanelToggle");
    this.onThinkingToggle = requiredFunction(onThinkingToggle, "onThinkingToggle");
    this.onTurnWindowJump = requiredFunction(onTurnWindowJump, "onTurnWindowJump");
    this.onRaw = requiredFunction(onRaw, "onRaw");
    this.onToolOriginJump = requiredFunction(onToolOriginJump, "onToolOriginJump");
    this.onRequestJump = requiredFunction(onRequestJump || onAgentJump, "onRequestJump");
    this.onAgentBranchJump = requiredFunction(onAgentBranchJump, "onAgentBranchJump");
    this.onAgentBranchSelect = requiredFunction(onAgentBranchSelect, "onAgentBranchSelect");
    this.onSupportingTimelineToggle = requiredFunction(onSupportingTimelineToggle, "onSupportingTimelineToggle");
    this.onSystemDiff = requiredFunction(onSystemDiff, "onSystemDiff");
    this.searchDelay = searchDelay;
    this.window = windowRef || globalThis;
    this.searchComposing = false;
    this.searchTimer = 0;
    this.bound = false;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.queryElement.addEventListener("input", (event) => this.handleQueryInput(event));
    this.queryElement.addEventListener("compositionstart", () => this.handleCompositionStart());
    this.queryElement.addEventListener("compositionend", (event) => this.handleCompositionEnd(event));
    this.queryElement.addEventListener("keydown", (event) => this.handleQueryKeydown(event));
    this.queryElement.addEventListener("click", (event) => this.handleQueryClick(event));
    this.timelineElement.addEventListener("click", (event) => this.handleTimelineClick(event));
    this.timelineElement.addEventListener("toggle", (event) => this.handleTimelineToggle(event), true);
  }

  render({ queryHtml, timelineHtml, activeTurnId, activeRequestId }) {
    this.queryElement.innerHTML = queryHtml;
    this.timelineElement.innerHTML = timelineHtml;
    this.syncActiveTurn(activeTurnId);
    this.syncActiveRequest(activeRequestId);
  }

  syncActiveTurn(id) {
    this.timelineElement
      .querySelectorAll("[data-turn-group]")
      .forEach((group) => group.classList.toggle("active", group.dataset.turnGroup === id));
  }

  syncActiveRequest(id) {
    this.timelineElement
      .querySelectorAll("[data-card]")
      .forEach((card) => card.classList.toggle("active", card.dataset.card === id));
  }

  handleQueryInput(event) {
    const input = closestWithin(event.target, "[data-trace-search]", this.queryElement);
    if (!input) return;
    this.onQueryChange(input.value || "");
    if (event.isComposing || this.searchComposing) return;
    this.scheduleSearchRender();
  }

  handleCompositionStart() {
    this.searchComposing = true;
    this.clearSearchTimer();
  }

  handleCompositionEnd(event) {
    const input = closestWithin(event.target, "[data-trace-search]", this.queryElement);
    this.searchComposing = false;
    if (!input) return;
    this.onQueryChange(input.value || "");
    this.scheduleSearchRender();
  }

  handleQueryKeydown(event) {
    const input = closestWithin(event.target, "[data-trace-search]", this.queryElement);
    if (input && event.key === "Enter" && !event.isComposing && !this.searchComposing) event.preventDefault();
  }

  handleQueryClick(event) {
    const filter = closestWithin(event.target, "[data-trace-filter]", this.queryElement);
    if (filter) {
      preventActionEvent(event);
      this.onFilter(filter.dataset.traceFilter || "all");
      return;
    }
    const more = closestWithin(event.target, "[data-trace-more]", this.queryElement);
    if (more) {
      preventActionEvent(event);
      this.onShowMore();
    }
  }

  handleTimelineClick(event) {
    const action = timelineAction(event.target, this.timelineElement);
    if (!action) return;
    preventActionEvent(event);
    if (action.type === "response-toggle") this.onResponseToggle(action.requestId);
    else if (action.type === "upstream-toggle") this.onUpstreamToggle(action.requestId);
    else if (action.type === "turn-window-jump") this.onTurnWindowJump(action.turnId);
    else if (action.type === "raw") this.onRaw(action);
    else if (action.type === "tool-origin-jump") this.onToolOriginJump(action);
    else if (action.type === "request-jump") this.onRequestJump(action.requestId);
    else if (action.type === "agent-branch-jump") this.onAgentBranchJump(action.branchId);
    else if (action.type === "agent-branch-select") this.onAgentBranchSelect(action.branchId);
    else if (action.type === "supporting-timeline-toggle") this.onSupportingTimelineToggle(action.turnId);
    else if (action.type === "system-diff") this.onSystemDiff(action.requestId);
  }

  handleTimelineToggle(event) {
    const thinking = closestWithin(event.target, "[data-thinking-request]", this.timelineElement);
    if (thinking) {
      this.onThinkingToggle({
        requestId: thinking.dataset.thinkingRequest || "",
        open: Boolean(thinking.open),
      });
      return;
    }
    const panel = closestWithin(event.target, "[data-upstream-panel]", this.timelineElement);
    if (panel) this.onUpstreamPanelToggle(panel);
  }

  scheduleSearchRender() {
    this.clearSearchTimer();
    this.searchTimer = this.window.setTimeout(() => {
      this.searchTimer = 0;
      this.onRenderRequested({ reason: "trace-search" });
      const restore = () => this.restoreSearchInputFocus();
      if (typeof this.window.requestAnimationFrame === "function") this.window.requestAnimationFrame(restore);
      else restore();
    }, this.searchDelay);
  }

  clearSearchTimer() {
    if (!this.searchTimer) return;
    this.window.clearTimeout(this.searchTimer);
    this.searchTimer = 0;
  }

  restoreSearchInputFocus() {
    const input = this.queryElement.querySelector("[data-trace-search]");
    if (!input) return;
    input.focus();
    const cursor = input.value.length;
    input.setSelectionRange(cursor, cursor);
  }
}

export function timelineAction(target, root) {
  const selectors = [
    ["[data-response-toggle]", (element) => ({ type: "response-toggle", requestId: element.dataset.responseToggle })],
    ["[data-upstream-toggle]", (element) => ({ type: "upstream-toggle", requestId: element.dataset.upstreamToggle })],
    ["[data-turn-window-jump]", (element) => ({ type: "turn-window-jump", turnId: element.dataset.turnWindowJump })],
    [
      "[data-tool-origin-jump]",
      (element) => ({
        type: "tool-origin-jump",
        originRequestId: element.dataset.toolOriginJump,
        resultRequestId: element.dataset.toolResultRequest,
        resultRequestIndex: element.dataset.toolResultIndex,
        callId: element.dataset.toolCallId || "",
      }),
    ],
    [
      "[data-raw]",
      (element) => ({
        type: "raw",
        requestId: element.dataset.raw,
        section: element.dataset.rawSection || "full",
        mode: element.dataset.rawMode || "request",
      }),
    ],
    ["[data-request-jump]", (element) => ({ type: "request-jump", requestId: element.dataset.requestJump })],
    ["[data-agent-jump]", (element) => ({ type: "request-jump", requestId: element.dataset.agentJump })],
    ["[data-agent-branch-jump]", (element) => ({ type: "agent-branch-jump", branchId: element.dataset.agentBranchJump })],
    ["[data-agent-branch-select]", (element) => ({ type: "agent-branch-select", branchId: element.dataset.agentBranchSelect })],
    [
      "[data-supporting-timeline-toggle]",
      (element) => ({ type: "supporting-timeline-toggle", turnId: element.dataset.supportingTimelineToggle }),
    ],
    ["[data-system-diff]", (element) => ({ type: "system-diff", requestId: element.dataset.systemDiff })],
  ];
  for (const [selector, build] of selectors) {
    const element = closestWithin(target, selector, root);
    if (element) return build(element);
  }
  return null;
}

function closestWithin(target, selector, root) {
  const element = target?.closest?.(selector);
  return element && root.contains(element) ? element : null;
}

function preventActionEvent(event) {
  event.preventDefault();
  event.stopPropagation();
}

function requiredElement(value, name) {
  if (!value || typeof value.addEventListener !== "function") throw new Error(`${name} is required`);
  return value;
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
