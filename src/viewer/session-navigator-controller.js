import { buildSessionNavigatorView, groupSourcesByAgentAndProject, sourceFamilyKey } from "./session-navigator-model.js";
import { renderSessionNavigator } from "./session-navigator-renderer.js";

const DEFAULT_COLLAPSE_KEY = "peekmyagent.collapsedProjects";

export class SessionNavigatorController {
  constructor({
    element,
    documentTarget,
    storage,
    translate,
    escapeHtml,
    projectNameFromWorkspace,
    projectGroupKey,
    displaySourceLabel,
    shortId,
    onSourceSelect,
    onFamilySelect = () => {},
    onSourceAction,
    onProjectAction,
    collapseStorageKey = DEFAULT_COLLAPSE_KEY,
  } = {}) {
    if (!element) throw new Error("element is required");
    if (!documentTarget) throw new Error("documentTarget is required");
    if (!storage) throw new Error("storage is required");
    if (typeof translate !== "function") throw new Error("translate is required");
    if (typeof escapeHtml !== "function") throw new Error("escapeHtml is required");
    if (typeof onSourceSelect !== "function") throw new Error("onSourceSelect is required");
    if (typeof onFamilySelect !== "function") throw new Error("onFamilySelect must be a function");
    if (typeof onSourceAction !== "function") throw new Error("onSourceAction is required");
    if (typeof onProjectAction !== "function") throw new Error("onProjectAction is required");

    this.element = element;
    this.documentTarget = documentTarget;
    this.storage = storage;
    this.translate = translate;
    this.escapeHtml = escapeHtml;
    this.modelDependencies = { projectNameFromWorkspace, projectGroupKey, displaySourceLabel, shortId };
    this.onSourceSelect = onSourceSelect;
    this.onFamilySelect = onFamilySelect;
    this.onSourceAction = onSourceAction;
    this.onProjectAction = onProjectAction;
    this.collapseStorageKey = collapseStorageKey;
    this.sources = [];
    this.activeSourceId = null;
    this.openSourceMenuId = null;
    this.openProjectMenuKey = null;
    this.selectedFamilyKey = null;
    this.collapsedProjects = this.readCollapsedProjects();

    this.handleClick = (event) => this.onClick(event);
    this.handleChange = (event) => this.onChange(event);
    this.handleDocumentClick = (event) => this.onDocumentClick(event);
    this.element.addEventListener("click", this.handleClick);
    this.element.addEventListener("change", this.handleChange);
    this.documentTarget.addEventListener("click", this.handleDocumentClick);
  }

  render({ sources = [], activeSourceId = null } = {}) {
    this.sources = sources;
    this.activeSourceId = activeSourceId;
    const activeSource = sources.find((source) => source.id === activeSourceId);
    if (activeSource) this.selectedFamilyKey = sourceFamilyKey(activeSource);
    else if (!sources.some((source) => sourceFamilyKey(source) === this.selectedFamilyKey)) {
      this.selectedFamilyKey = sources[0] ? sourceFamilyKey(sources[0]) : null;
    }
    this.renderCurrent();
  }

  onChange(event) {
    const select = this.closestWithin(event.target, "[data-source-family-select]");
    if (!select) return;
    const familyKey = select.value;
    const familySources = this.sources.filter((source) => sourceFamilyKey(source) === familyKey);
    if (!familySources.length) return;
    this.selectedFamilyKey = familyKey;
    this.closeMenus();
    this.renderCurrent();
    this.onFamilySelect({ familyKey, sources: familySources });
  }

  onClick(event) {
    const target = event.target;
    const projectToggle = this.closestWithin(target, "[data-project-toggle]");
    if (projectToggle) {
      event.preventDefault();
      event.stopPropagation();
      this.toggleProject(projectToggle.dataset.projectToggle);
      return;
    }
    const projectAction = this.closestWithin(target, "[data-project-action]");
    if (projectAction) {
      event.preventDefault();
      event.stopPropagation();
      this.handleProjectAction(projectAction.dataset.projectAction, projectAction.dataset.projectKey);
      return;
    }
    const sourceAction = this.closestWithin(target, "[data-source-action]");
    if (sourceAction) {
      event.preventDefault();
      event.stopPropagation();
      this.handleSourceAction(sourceAction.dataset.sourceAction, sourceAction.dataset.sourceId);
      return;
    }
    const sourceButton = this.closestWithin(target, "[data-source]");
    if (!sourceButton) return;
    const source = this.sources.find((item) => item.id === sourceButton.dataset.source);
    if (!source?.available) return;
    this.closeMenus({ render: true });
    this.onSourceSelect(source.id);
  }

  onDocumentClick(event) {
    if (!this.openSourceMenuId && !this.openProjectMenuKey) return;
    if (this.closestWithin(event.target, "[data-source-action], [data-project-action], .session-menu")) return;
    this.closeMenus({ render: true });
  }

  toggleProject(key) {
    if (!key) return;
    this.collapsedProjects[key] = !this.collapsedProjects[key];
    this.writeCollapsedProjects();
    this.renderCurrent();
  }

  handleSourceAction(action, sourceId) {
    const source = this.sources.find((item) => item.id === sourceId);
    if (!source) return;
    if (action === "menu") {
      this.openSourceMenuId = this.openSourceMenuId === sourceId ? null : sourceId;
      this.openProjectMenuKey = null;
      this.renderCurrent();
      return;
    }
    this.closeMenus({ render: true });
    this.onSourceAction({ action, source });
  }

  handleProjectAction(action, projectKey) {
    const projectGroup = this.projectGroups().find((group) => group.key === projectKey);
    if (!projectGroup) return;
    if (action === "menu") {
      this.openProjectMenuKey = this.openProjectMenuKey === projectKey ? null : projectKey;
      this.openSourceMenuId = null;
      this.renderCurrent();
      return;
    }
    this.closeMenus({ render: true });
    this.onProjectAction({ action, projectGroup });
  }

  projectGroups() {
    return groupSourcesByAgentAndProject(this.sources, {
      translate: this.translate,
      ...this.modelDependencies,
    }).flatMap((agentGroup) => agentGroup.projects);
  }

  renderCurrent() {
    const activeSource = this.sources.find((source) => source.id === this.activeSourceId);
    const visibleActiveSourceId =
      activeSource && sourceFamilyKey(activeSource) === this.selectedFamilyKey
        ? this.activeSourceId
        : null;
    const view = buildSessionNavigatorView({
      sources: this.sources,
      activeSourceId: visibleActiveSourceId,
      selectedFamilyKey: this.selectedFamilyKey,
      collapsedProjects: this.collapsedProjects,
      openSourceMenuId: this.openSourceMenuId,
      openProjectMenuKey: this.openProjectMenuKey,
      translate: this.translate,
      ...this.modelDependencies,
    });
    this.element.innerHTML = renderSessionNavigator(view, {
      escapeHtml: this.escapeHtml,
      translate: this.translate,
    });
  }

  closeMenus({ render = false } = {}) {
    const changed = Boolean(this.openSourceMenuId || this.openProjectMenuKey);
    this.openSourceMenuId = null;
    this.openProjectMenuKey = null;
    if (render && changed) this.renderCurrent();
  }

  closestWithin(target, selector) {
    const match = target?.closest?.(selector);
    return match && this.element.contains(match) ? match : null;
  }

  readCollapsedProjects() {
    try {
      const value = JSON.parse(this.storage.getItem(this.collapseStorageKey) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  writeCollapsedProjects() {
    this.storage.setItem(this.collapseStorageKey, JSON.stringify(this.collapsedProjects));
  }

  destroy() {
    this.element.removeEventListener("click", this.handleClick);
    this.element.removeEventListener("change", this.handleChange);
    this.documentTarget.removeEventListener("click", this.handleDocumentClick);
    this.element.innerHTML = "";
    this.sources = [];
    this.activeSourceId = null;
    this.selectedFamilyKey = null;
    this.closeMenus();
  }
}
