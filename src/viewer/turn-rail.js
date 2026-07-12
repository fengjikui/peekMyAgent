export const TURN_RAIL_MIN_ITEMS = 24;
export const TURN_RAIL_MAX_ITEMS = 72;
export const TURN_RAIL_ITEM_PITCH = 11;

export class TurnRailController {
  constructor({
    element,
    mainPanel,
    getTurns,
    getActiveId,
    hasData,
    titleFor,
    excerptFor,
    translate,
    escapeHtml,
    onJump,
    onActiveChange,
    documentRef = document,
    windowRef = window,
  } = {}) {
    this.element = element;
    this.mainPanel = mainPanel;
    this.getTurns = requiredFunction(getTurns, "getTurns");
    this.getActiveId = requiredFunction(getActiveId, "getActiveId");
    this.hasData = requiredFunction(hasData, "hasData");
    this.titleFor = requiredFunction(titleFor, "titleFor");
    this.excerptFor = requiredFunction(excerptFor, "excerptFor");
    this.translate = requiredFunction(translate, "translate");
    this.escapeHtml = requiredFunction(escapeHtml, "escapeHtml");
    this.onJump = requiredFunction(onJump, "onJump");
    this.onActiveChange = requiredFunction(onActiveChange, "onActiveChange");
    this.document = documentRef;
    this.window = windowRef;
    this.scrollRaf = 0;
    this.bound = false;
  }

  bind() {
    if (this.bound || !this.element || !this.mainPanel) return;
    this.bound = true;
    this.element.addEventListener("click", (event) => {
      const button = event.target.closest("[data-turn]");
      if (!button || !this.element.contains(button)) return;
      this.onJump(button.dataset.turn, true);
    });
    const updateHover = (event) => {
      const button = event.target.closest("[data-turn]");
      if (!button || !this.element.contains(button)) return;
      this.updateHover(button.dataset.turn);
    };
    this.element.addEventListener("pointerover", updateHover);
    this.element.addEventListener("pointermove", updateHover);
    this.element.addEventListener("mousemove", updateHover);
    this.element.addEventListener("pointerleave", () => this.clearHover());
    this.mainPanel.addEventListener("scroll", () => this.scheduleActiveSync(), { passive: true });
  }

  render() {
    if (!this.element || !this.hasData()) {
      if (this.element) this.element.innerHTML = "";
      return;
    }
    const allTurns = this.getTurns() || [];
    const activeId = this.getActiveId();
    const turns = visibleTurnWindow(allTurns, activeId, railMaxItems(this.window.innerHeight));
    const activeIndex = allTurns.findIndex((turn) => turn.id === activeId);
    const windowStart = turns.length ? allTurns.findIndex((turn) => turn.id === turns[0].id) : 0;
    const windowEnd = windowStart + turns.length;
    const topHint = windowStart > 0 ? '<span class="turn-window-edge" aria-hidden="true"></span>' : "";
    const bottomHint = windowEnd < allTurns.length ? '<span class="turn-window-edge" aria-hidden="true"></span>' : "";
    this.element.innerHTML = `${topHint}${turns.map((turn) => this.renderItem(turn, activeId)).join("")}${bottomHint}`;
    this.element.setAttribute(
      "aria-label",
      activeIndex >= 0
        ? this.translate("turnRailAriaDynamic", { current: activeIndex + 1, total: allTurns.length })
        : this.translate("turnRailAriaTotal", { total: allTurns.length }),
    );
  }

  renderItem(turn, activeId) {
    const active = turn.id === activeId;
    const subagent = turn.subagent_count ? "subagent" : "";
    return `
      <button class="turn-mark ${subagent} ${active ? "active" : ""}" type="button" data-turn="${this.escapeHtml(turn.id)}" aria-label="${this.escapeHtml(this.translate("jumpToTurnAria", { index: turn.index }))}">
        <span class="turn-line"></span>
        <span class="turn-tooltip">
          <strong>Turn ${this.escapeHtml(turn.index)} · ${this.escapeHtml(this.titleFor(turn))}</strong>
          <span>${this.escapeHtml(this.excerptFor(turn))}</span>
        </span>
      </button>
    `;
  }

  updateHover(turnId) {
    if (!this.element) return;
    const buttons = [...this.element.querySelectorAll("[data-turn]")];
    const hoveredIndex = buttons.findIndex((button) => button.dataset.turn === turnId);
    this.element.classList.toggle("hovering", hoveredIndex >= 0);
    buttons.forEach((button, index) => {
      button.classList.remove("hover-center", "hover-near-1", "hover-near-2", "hover-near-3");
      const hoverClass = hoverClassForDistance(index - hoveredIndex, hoveredIndex >= 0);
      if (hoverClass) button.classList.add(hoverClass);
    });
  }

  clearHover() {
    if (!this.element) return;
    this.element.classList.remove("hovering");
    this.element.querySelectorAll("[data-turn]").forEach((button) => {
      button.classList.remove("hover-center", "hover-near-1", "hover-near-2", "hover-near-3");
    });
  }

  scheduleActiveSync() {
    if (this.scrollRaf) return;
    this.scrollRaf = this.window.requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.syncActiveFromScroll();
    });
  }

  syncActiveFromScroll() {
    if (!this.hasData()) return;
    const turnGroups = [...this.document.querySelectorAll("[data-turn-group]")];
    if (!turnGroups.length) return;
    const { scrollTop, scrollHeight, clientHeight } = this.mainPanel;
    const bottomSnap = Math.min(160, clientHeight * 0.18);
    if (scrollTop + clientHeight >= scrollHeight - bottomSnap) {
      this.activateCandidate(turnGroups.at(-1));
      return;
    }
    const activePosition = scrollTop + 118;
    let candidate = turnGroups[0];
    for (let index = 1; index < turnGroups.length; index += 1) {
      const previousTop = turnGroups[index - 1].offsetTop;
      const currentTop = turnGroups[index].offsetTop;
      if (activePosition >= previousTop + (currentTop - previousTop) / 2) candidate = turnGroups[index];
      else break;
    }
    this.activateCandidate(candidate);
  }

  activateCandidate(candidate) {
    const id = candidate?.dataset.turnGroup;
    if (id && id !== this.getActiveId()) this.onActiveChange(id, false);
  }
}

export function visibleTurnWindow(turns, activeId, maxItems) {
  const allTurns = Array.isArray(turns) ? turns : [];
  const limit = Math.max(1, Math.floor(Number(maxItems) || TURN_RAIL_MIN_ITEMS));
  if (allTurns.length <= limit) return allTurns;
  const activeIndex = Math.max(0, allTurns.findIndex((turn) => turn.id === activeId));
  const halfWindow = Math.floor(limit / 2);
  const maxStart = Math.max(0, allTurns.length - limit);
  const start = Math.min(Math.max(0, activeIndex - halfWindow), maxStart);
  return allTurns.slice(start, start + limit);
}

export function railMaxItems(viewportHeight) {
  const available = Math.max(220, Number(viewportHeight || 0) - 340);
  return Math.min(TURN_RAIL_MAX_ITEMS, Math.max(TURN_RAIL_MIN_ITEMS, Math.floor(available / TURN_RAIL_ITEM_PITCH)));
}

export function hoverClassForDistance(distance, active = true) {
  if (!active) return "";
  const absolute = Math.abs(Number(distance));
  if (absolute === 0) return "hover-center";
  return absolute <= 3 ? `hover-near-${absolute}` : "";
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
