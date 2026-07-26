import { hoverClassForDistance, truncateRailPrompt } from "./turn-rail.js";

export const REQUEST_RAIL_THRESHOLD = 5;
export const REQUEST_RAIL_MAX_ITEMS = 18;
export const REQUEST_RAIL_DENSE_THRESHOLD = REQUEST_RAIL_MAX_ITEMS;
export const REQUEST_RAIL_ITEM_PITCH = 52;

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
      if (button && this.element.contains(button)) this.updateHover(button.dataset.request);
    };
    this.element.addEventListener("pointerover", updateHover);
    this.element.addEventListener("pointermove", updateHover);
    this.element.addEventListener("pointerleave", () => this.clearHover());
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
    const dense = allRequests.length > REQUEST_RAIL_DENSE_THRESHOLD;
    const requests = dense
      ? allRequests
      : visibleRequestWindow(
          allRequests,
          activeId,
          requestRailMaxItems(this.mainPanel?.clientWidth || this.window.innerWidth),
        );
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
      <span class="request-rail-track ${dense ? "dense" : ""}">${requests.map((request) => this.renderItem(request, activeId, dense)).join("")}</span>
    `;
    this.element.setAttribute(
      "aria-label",
      activePosition >= 0
        ? this.translate("requestRailAriaDynamic", { current: activePosition + 1, total: allRequests.length })
        : this.translate("requestRailAriaTotal", { total: allRequests.length }),
    );
  }

  renderItem(request, activeId, dense = false) {
    const active = request.id === activeId;
    return `
      <button class="request-mark ${dense ? "signal" : ""} ${active ? "active" : ""}" type="button" data-request="${this.escapeHtml(request.id)}" aria-label="${this.escapeHtml(this.translate("jumpToRequestAria", { index: request.request_index }))}" ${active ? 'aria-current="step"' : ""}>
        ${dense ? '<span class="request-line"></span>' : ""}
        <span class="request-number">#${this.escapeHtml(request.request_index)}</span>
        <span class="request-tooltip">
          <strong>#${this.escapeHtml(request.request_index)}</strong>
          <span>${this.escapeHtml(truncateRailPrompt(this.promptFor(request)))}</span>
        </span>
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

export function visibleRequestWindow(requests, activeId, maxItems) {
  const allRequests = Array.isArray(requests) ? requests : [];
  const limit = Math.max(1, Math.floor(Number(maxItems) || REQUEST_RAIL_MAX_ITEMS));
  if (allRequests.length <= limit) return allRequests;
  const activeIndex = Math.max(0, allRequests.findIndex((request) => request.id === activeId));
  const maxStart = Math.max(0, allRequests.length - limit);
  const start = Math.min(Math.max(0, activeIndex - Math.floor(limit / 2)), maxStart);
  return allRequests.slice(start, start + limit);
}

export function requestRailMaxItems(viewportWidth) {
  const available = Math.max(260, Number(viewportWidth || 0) - 190);
  return Math.min(REQUEST_RAIL_MAX_ITEMS, Math.max(REQUEST_RAIL_THRESHOLD, Math.floor(available / REQUEST_RAIL_ITEM_PITCH)));
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
