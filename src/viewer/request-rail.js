export const REQUEST_RAIL_THRESHOLD = 5;
export const REQUEST_RAIL_MAX_ITEMS = 18;
export const REQUEST_RAIL_ITEM_PITCH = 52;

export class RequestRailController {
  constructor({
    element,
    mainPanel,
    getRequests,
    getActiveId,
    getActiveTurnId,
    titleFor,
    excerptFor,
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
    this.titleFor = requiredFunction(titleFor, "titleFor");
    this.excerptFor = requiredFunction(excerptFor, "excerptFor");
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
    const requests = visibleRequestWindow(
      allRequests,
      activeId,
      requestRailMaxItems(this.mainPanel?.clientWidth || this.window.innerWidth),
    );
    this.element.hidden = false;
    this.element.removeAttribute("aria-hidden");
    this.element.innerHTML = `
      <span class="request-rail-context">
        <strong>${this.escapeHtml(this.translate("requestRailContext"))}</strong>
        <span>${this.escapeHtml(this.translate("requestRailPosition", {
          current: activePosition >= 0 ? activePosition + 1 : 1,
          total: allRequests.length,
        }))}</span>
      </span>
      <span class="request-rail-track">${requests.map((request) => this.renderItem(request, activeId)).join("")}</span>
    `;
    this.element.setAttribute(
      "aria-label",
      activePosition >= 0
        ? this.translate("requestRailAriaDynamic", { current: activePosition + 1, total: allRequests.length })
        : this.translate("requestRailAriaTotal", { total: allRequests.length }),
    );
  }

  renderItem(request, activeId) {
    return `
      <button class="request-mark ${request.id === activeId ? "active" : ""}" type="button" data-request="${this.escapeHtml(request.id)}" aria-label="${this.escapeHtml(this.translate("jumpToRequestAria", { index: request.request_index }))}">
        <span class="request-number">#${this.escapeHtml(request.request_index)}</span>
        <span class="request-tooltip">
          <strong>#${this.escapeHtml(request.request_index)} · ${this.escapeHtml(this.titleFor(request))}</strong>
          <span>${this.escapeHtml(this.excerptFor(request))}</span>
        </span>
      </button>
    `;
  }

  syncActiveRequest(id) {
    if (!this.element) return;
    this.element
      .querySelectorAll("[data-request]")
      .forEach((button) => button.classList.toggle("active", button.dataset.request === id));
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
