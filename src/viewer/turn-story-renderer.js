export function renderTurnStory(view, { translate, escapeHtml } = {}) {
  if (!view?.steps?.length || typeof translate !== "function" || typeof escapeHtml !== "function") return "";
  return `
    <div class="turn-story" aria-label="${escapeHtml(translate("turnStoryAria"))}">
      <span class="turn-story-label">${escapeHtml(translate("turnStoryLabel"))}</span>
      <div class="turn-story-steps">
        ${view.steps.map((step, index) => renderStoryStep(step, index, { translate, escapeHtml })).join("")}
      </div>
    </div>
  `;
}

function renderStoryStep(step, index, { translate, escapeHtml }) {
  const label = escapeHtml(step.label || "");
  const content = step.requestId
    ? `<button class="turn-story-step ${escapeHtml(step.kind || "")}" type="button" data-request-jump="${escapeHtml(step.requestId)}" title="${escapeHtml(translate("turnStoryJumpEvidence", { index: step.requestIndex || "" }))}">${label}</button>`
    : `<span class="turn-story-step ${escapeHtml(step.kind || "")}">${label}</span>`;
  const arrow = index > 0 ? '<span class="turn-story-arrow" aria-hidden="true">→</span>' : "";
  return `<span class="turn-story-segment">${arrow}${content}</span>`;
}
