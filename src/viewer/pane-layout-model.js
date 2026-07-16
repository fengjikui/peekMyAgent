export const PANE_LAYOUT_LIMITS = Object.freeze({
  rawMin: 320,
  rawMax: 760,
  sidebarMin: 220,
  sidebarMax: 420,
  mainMin: 520,
  resizerWidth: 6,
});

export function clampRawPanelWidth(width, layout, limits = PANE_LAYOUT_LIMITS) {
  return clampWidth(width, limits.rawMin, maximumRawPanelWidth(layout, limits));
}

export function clampSidebarWidth(width, layout, limits = PANE_LAYOUT_LIMITS) {
  return clampWidth(width, limits.sidebarMin, maximumSidebarWidth(layout, limits));
}

export function maximumRawPanelWidth(layout, limits = PANE_LAYOUT_LIMITS) {
  const shellWidth = positiveNumber(layout.shellWidth);
  const sidebarWidth = layout.sidebarOpen ? positiveNumber(layout.sidebarWidth) : 0;
  const sidebarResizerWidth = layout.sidebarOpen ? limits.resizerWidth : 0;
  const roomForRaw = shellWidth - sidebarWidth - sidebarResizerWidth - limits.mainMin - limits.resizerWidth;
  return Math.max(limits.rawMin, Math.min(limits.rawMax, roomForRaw));
}

export function maximumSidebarWidth(layout, limits = PANE_LAYOUT_LIMITS) {
  const shellWidth = positiveNumber(layout.shellWidth);
  const rawWidth = layout.rawOpen ? positiveNumber(layout.rawWidth) : 0;
  const rawResizerWidth = layout.rawOpen ? limits.resizerWidth : 0;
  const roomForSidebar = shellWidth - rawWidth - rawResizerWidth - limits.mainMin - limits.resizerWidth;
  return Math.max(limits.sidebarMin, Math.min(limits.sidebarMax, roomForSidebar));
}

export function contentPanelWidth(layout, limits = PANE_LAYOUT_LIMITS) {
  const shellWidth = positiveNumber(layout.shellWidth);
  const sidebarWidth = layout.sidebarOpen ? positiveNumber(layout.sidebarWidth) : 0;
  const sidebarResizerWidth = layout.sidebarOpen ? limits.resizerWidth : 0;
  const rawResizerWidth = layout.rawOpen ? limits.resizerWidth : 0;
  return Math.max(0, shellWidth - sidebarWidth - sidebarResizerWidth - rawResizerWidth);
}

export function panelContentShare(panelWidth, contentWidth) {
  const available = positiveNumber(contentWidth);
  return available ? positiveNumber(panelWidth) / available : 0;
}

function clampWidth(value, minimum, maximum) {
  return Math.round(Math.min(Math.max(Number(value) || minimum, minimum), maximum));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
