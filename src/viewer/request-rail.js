import { hoverClassForDistance, truncateRailPrompt } from "./turn-rail.js";

export const REQUEST_RAIL_THRESHOLD = 5;

export class RequestRailController {
  constructor({
    element,
    mainPanel,
    getRequests,
    getActiveId,
    getActiveTurnId,
    promptFor,
    translate,
    escapeHtml,
    onJump,
    onActiveChange,
    documentRef = document,
    windowRef = window,
    threshold = REQUEST_RAIL_THRESHOLD,
  } = {}) {
    this.element = element;
    this.mainPanel = mainPanel;
    this.getRequests = requiredFunction(getRequests, "getRequests");
    this.getActiveId = requiredFunction(getActiveId, "getActiveId");
    this.getActiveTurnId = requiredFunction(getActiveTurnId, "getActiveTurnId");
    this.promptFor = requiredFunction(promptFor, "promptFor");
    this.translate = requiredFunction(translate, "translate");
    this.escapeHtml = requiredFunction(escapeHtml, "escapeHtml");
    this.onJump = requiredFunction(onJump, "onJump");
    this.onActiveChange = requiredFunction(onActiveChange, "onActiveChange");
    this.document = documentRef;
    this.window = windowRef;
    this.threshold = Math.max(1, Math.floor(Number(threshold) || REQUEST_RAIL_THRESHOLD));
    this.scrollRaf = 0;
    this.bound = false;
  }

  bind() {
    if (this.bound || !this.element || !this.mainPanel) return;
    this.bound = true;
    this.element.addEventListener("click", (event) => {
      const button = event.target.closest("[data-request]");
      if (!button || !this.element.contains(button)) return;
      this.onJump(button.dataset.request);
    });
    const updateHover = (event) => {
      const button = event.target.closest("[data-request]");
      if (!button || !this.element.contains(button)) return;
      this.updateHover(button.dataset.request);
      this.showTooltip(button.dataset.request, button);
    };
    this.element.addEventListener("pointerover", updateHover);
    this.element.addEventListener("pointermove", updateHover);
    this.element.addEventListener("pointerleave", () => this.clearHover());
    this.element.addEventListener("focusin", updateHover);
    this.element.addEventListener("focusout", (event) => {
      if (!this.element.contains(event.relatedTarget)) this.clearHover();
    });
    this.mainPanel.addEventListener("scroll", () => this.scheduleActiveSync(), { passive: true });
  }

  render() {
    if (!this.element) return;
    const allRequests = this.getRequests() || [];
    if (allRequests.length < this.threshold) {
      this.element.innerHTML = "";
      this.element.hidden = true;
      this.element.setAttribute("aria-hidden", "true");
      return;
    }
    const activeId = this.getActiveId();
    const activePosition = allRequests.findIndex((request) => request.id === activeId);
    const activeRequest = activePosition >= 0 ? allRequests[activePosition] : allRequests[0];
    this.element.hidden = false;
    this.element.removeAttribute("aria-hidden");
    this.element.innerHTML = `
      <span class="request-rail-context">
        <strong>${this.escapeHtml(this.translate("requestRailContext"))}</strong>
        <span data-request-rail-position>${this.escapeHtml(this.translate("requestRailPosition", {
          index: activeRequest?.request_index || activePosition + 1 || 1,
          current: activePosition >= 0 ? activePosition + 1 : 1,
          total: allRequests.length,
        }))}</span>
      </span>
      <span class="request-rail-track">${allRequests.map((request) => this.renderItem(request, activeId)).join("")}</span>
      <span id="requestRailTooltip" class="request-tooltip" role="tooltip" data-request-tooltip aria-hidden="true">
        <strong data-request-tooltip-index></strong>
        <span data-request-tooltip-prompt></span>
      </span>
    `;
    this.element.setAttribute(
      "aria-label",
      activePosition >= 0
        ? this.translate("requestRailAriaDynamic", { current: activePosition + 1, total: allRequests.length })
        : this.translate("requestRailAriaTotal", { total: allRequests.length }),
    );
  }

  renderItem(request, activeId) {
    const active = request.id === activeId;
    return `
      <button class="request-mark ${active ? "active" : ""}" type="button" data-request="${this.escapeHtml(request.id)}" aria-label="${this.escapeHtml(this.translate("jumpToRequestAria", { index: request.request_index }))}" aria-describedby="requestRailTooltip" ${active ? 'aria-current="step"' : ""}>
        <span class="request-line"></span>
      </button>
    `;
  }

  syncActiveRequest(id) {
    if (!this.element) return;
    let activeButton = null;
    this.element.querySelectorAll("[data-request]").forEach((button) => {
      const active = button.dataset.request === id;
      button.classList.toggle("active", active);
      if (active) {
        button.setAttribute("aria-current", "step");
        activeButton = button;
      } else {
        button.removeAttribute("aria-current");
      }
    });
    this.syncActiveContext(id);
    const track = activeButton?.closest?.(".request-rail-track");
    if (track && track.scrollWidth > track.clientWidth) {
      const left = Math.max(0, activeButton.offsetLeft - (track.clientWidth - activeButton.offsetWidth) / 2);
      track.scrollTo?.({ left, behavior: "auto" });
    }
  }

  updateHover(requestId) {
    const buttons = [...this.element.querySelectorAll("[data-request]")];
    const hoveredIndex = buttons.findIndex((button) => button.dataset.request === requestId);
    this.element.classList.toggle("hovering", hoveredIndex >= 0);
    buttons.forEach((button, index) => {
      button.classList.remove("hover-center", "hover-near-1", "hover-near-2", "hover-near-3");
      const hoverClass = hoverClassForDistance(index - hoveredIndex, hoveredIndex >= 0);
      if (hoverClass) button.classList.add(hoverClass);
    });
  }

  clearHover() {
    this.element.classList.remove("hovering");
    this.element.querySelectorAll("[data-request]").forEach((button) => {
      button.classList.remove("hover-center", "hover-near-1", "hover-near-2", "hover-near-3");
    });
    this.hideTooltip();
  }

  showTooltip(requestId, button) {
    const request = (this.getRequests() || []).find((item) => item.id === requestId);
    const tooltip = this.element.querySelector("[data-request-tooltip]");
    if (!request || !tooltip || !button) return;
    const index = tooltip.querySelector("[data-request-tooltip-index]");
    const prompt = tooltip.querySelector("[data-request-tooltip-prompt]");
    if (index) index.textContent = `#${request.request_index}`;
    if (prompt) prompt.textContent = truncateRailPrompt(this.promptFor(request));
    const railRect = this.element.getBoundingClientRect?.();
    const buttonRect = button.getBoundingClientRect?.();
    if (railRect && buttonRect) {
      const tooltipHalfWidth = Math.min(130, Math.max(72, (railRect.width - 16) / 2));
      const preferredLeft = buttonRect.left + buttonRect.width / 2 - railRect.left;
      const left = Math.min(Math.max(preferredLeft, tooltipHalfWidth + 4), railRect.width - tooltipHalfWidth - 4);
      tooltip.style.setProperty("--request-tooltip-left", `${left}px`);
    }
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
  }

  hideTooltip() {
    const tooltip = this.element.querySelector("[data-request-tooltip]");
    if (!tooltip) return;
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
  }

  syncActiveContext(id) {
    const requests = this.getRequests() || [];
    const activePosition = requests.findIndex((request) => request.id === id);
    if (activePosition < 0) return;
    const activeRequest = requests[activePosition];
    const values = {
      index: activeRequest.request_index || activePosition + 1,
      current: activePosition + 1,
      total: requests.length,
    };
    const position = this.element.querySelector("[data-request-rail-position]");
    if (position) position.textContent = this.translate("requestRailPosition", values);
    this.element.setAttribute("aria-label", this.translate("requestRailAriaDynamic", values));
  }

  scheduleActiveSync() {
    if (this.scrollRaf) return;
    this.scrollRaf = this.window.requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.syncActiveFromScroll();
    });
  }

  syncActiveFromScroll() {
    const allowedIds = new Set((this.getRequests() || []).map((request) => request.id));
    if (allowedIds.size < this.threshold) return;
    const activeTurnId = this.getActiveTurnId();
    const activeGroup = [...this.document.querySelectorAll("[data-turn-group]")]
      .find((group) => group.dataset.turnGroup === activeTurnId);
    const cards = [...(activeGroup?.querySelectorAll?.("[data-card]") || [])]
      .filter((card) => allowedIds.has(card.dataset.card));
    if (!cards.length) return;
    const { scrollTop, scrollHeight, clientHeight } = this.mainPanel;
    const bottomSnap = Math.min(140, clientHeight * 0.16);
    if (scrollTop + clientHeight >= scrollHeight - bottomSnap) {
      this.activateCandidate(cards.at(-1));
      return;
    }
    const activePosition = scrollTop + 118;
    let candidate = cards[0];
    for (let index = 1; index < cards.length; index += 1) {
      const previousTop = elementScrollTop(cards[index - 1], this.mainPanel);
      const currentTop = elementScrollTop(cards[index], this.mainPanel);
      if (activePosition >= previousTop + (currentTop - previousTop) / 2) candidate = cards[index];
      else break;
    }
    this.activateCandidate(candidate);
  }

  activateCandidate(candidate) {
    const id = candidate?.dataset.card;
    if (id && id !== this.getActiveId()) this.onActiveChange(id, false);
  }
}

function elementScrollTop(element, scroller) {
  if (typeof element?.getBoundingClientRect === "function" && typeof scroller?.getBoundingClientRect === "function") {
    return scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }
  return Number(element?.offsetTop || 0);
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
