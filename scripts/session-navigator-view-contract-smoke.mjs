#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { SessionNavigatorController } from "../src/viewer/session-navigator-controller.js";
import {
  buildSessionNavigatorView,
  buildSourceFamilyOptions,
  groupSourcesByAgentAndProject,
  sourceFamilyKey,
} from "../src/viewer/session-navigator-model.js";
import { renderSessionNavigator } from "../src/viewer/session-navigator-renderer.js";

const translations = {
  archive: "Archive",
  archiveProject: "Archive project",
  deleteData: "Delete data",
  deleteProjectData: "Delete project data",
  exportTrace: "Export Trace",
  importedTraces: "Imported traces",
  liveTrace: "Live trace",
  moreActions: "More actions",
  pin: "Pin",
  projectActionsAria: "Project actions",
  rename: "Rename",
  observedAgent: "Viewing",
  observedAgentAria: "Choose Agent",
  requestUnit: "{count} requests",
  sessionActionsAria: "Session actions",
  unassignedProject: "Unassigned",
  unpin: "Unpin",
  unknownAgent: "Unknown Agent",
};
const translate = (key, values = {}) =>
  String(translations[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const sources = [
  {
    id: "source-1",
    agent: "Claude Code",
    workspace: "C:\\work\\demo",
    label: "First <trace>",
    conversation_id: "12345678-1234-1234-1234-123456789abc",
    request_count: 12,
    available: true,
    pinned: true,
    live_watch_id: "watch-1",
    live_status: "watching",
  },
  {
    id: "source-2",
    agent: "Claude Code",
    workspace: "C:\\work\\demo",
    label: "Second trace",
    request_count: 2,
    available: false,
  },
  {
    id: "source-3",
    agent: "OpenClaw",
    workspace: "/tmp/other",
    label: "Other trace",
    request_count: 1,
    available: true,
  },
  {
    id: "source-4",
    agent: "Codex",
    workspace: "/tmp/codex-project",
    label: "Read-only Codex trace",
    conversation_id: "codex-thread",
    request_count: null,
    available: true,
    deletable: false,
  },
];

const groups = groupSourcesByAgentAndProject(sources, { translate });
assert.equal(groups.length, 3);
assert.equal(groups[0].projects[0].project, "demo", "Windows workspaces should produce a portable project name");
assert.equal(groups[0].projects[0].sources.length, 2);
assert.equal(groups[1].projects[0].project, "other");
const unassignedKey = groupSourcesByAgentAndProject([{ id: "unassigned", agent: "Claude Code" }], { translate })[0].projects[0].key;
const localizedUnassignedKey = groupSourcesByAgentAndProject([{ id: "unassigned", agent: "Claude Code" }], {
  translate: (key) => (key === "unassignedProject" ? "未分配项目" : key),
})[0].projects[0].key;
assert.equal(localizedUnassignedKey, unassignedKey, "project identity must not change with the UI language");
assert.equal(sourceFamilyKey(sources[0]), "agent:claude code");
assert.equal(sourceFamilyKey({ ...sources[0], kind: "imported_trace" }), "imported");
const families = buildSourceFamilyOptions([...sources, { ...sources[2], id: "imported", kind: "imported_trace" }], {
  activeSourceId: "source-4",
  translate,
});
assert.equal(families.length, 4);
assert.equal(families.find((family) => family.active)?.label, "Codex");
assert.equal(families.find((family) => family.kind === "imported")?.label, "Imported traces");

const projectKey = groups[0].projects[0].key;
const view = buildSessionNavigatorView({
  sources,
  activeSourceId: "source-1",
  collapsedProjects: {},
  openSourceMenuId: "source-1",
  translate,
});
const sourceView = view.agentGroups[0].projects[0].sourceViews[0];
assert.equal(sourceView.active, true);
assert.equal(sourceView.menuOpen, true);
assert.equal(sourceView.pinLabel, "Unpin");
assert.equal(sourceView.subtitle, "12345678...9abc");

const html = renderSessionNavigator(view, { escapeHtml, translate });
assert.match(html, /First &lt;trace&gt;/);
assert.match(html, /12 requests/);
assert.match(html, /data-source-family-select/);
assert.match(html, /Claude Code · 2/);
assert.doesNotMatch(html, /Other trace/, "only the selected Agent family is rendered");
assert.match(html, /data-source-action="export"/);
assert.doesNotMatch(html, /First <trace>/);

const codexView = buildSessionNavigatorView({
  sources: [sources[3]],
  openSourceMenuId: "source-4",
  translate,
});
const codexSourceView = codexView.agentGroups[0].projects[0].sourceViews[0];
assert.equal(codexSourceView.requestLabel, "Live trace");
assert.equal(codexSourceView.canDelete, false);
assert.equal(codexView.agentGroups[0].projects[0].canDelete, false);
const codexHtml = renderSessionNavigator(codexView, { escapeHtml, translate });
assert.match(codexHtml, /Live trace/);
assert.match(codexHtml, /data-source-action="archive"/);
assert.doesNotMatch(codexHtml, /data-source-action="delete"/);
assert.doesNotMatch(codexHtml, /data-project-action="delete"/);

const collapsedView = buildSessionNavigatorView({
  sources,
  collapsedProjects: { [projectKey]: true },
  translate,
});
assert.equal(collapsedView.agentGroups[0].projects[0].sourceViews.length, 0);
assert.doesNotMatch(renderSessionNavigator(collapsedView, { escapeHtml, translate }), /data-source="source-1"/);

const element = createFakeEventTarget({ contains: () => true });
const documentTarget = createFakeEventTarget();
const stored = new Map();
const storage = {
  getItem(key) {
    return stored.get(key) ?? null;
  },
  setItem(key, value) {
    stored.set(key, value);
  },
};
const selected = [];
const selectedFamilies = [];
const sourceActions = [];
const projectActions = [];
const controller = new SessionNavigatorController({
  element,
  documentTarget,
  storage,
  translate,
  escapeHtml,
  onSourceSelect: (sourceId) => selected.push(sourceId),
  onFamilySelect: (payload) => selectedFamilies.push(payload),
  onSourceAction: (payload) => sourceActions.push(payload),
  onProjectAction: (payload) => projectActions.push(payload),
});

assert.equal(element.listenerCount("click"), 1, "the navigator should bind one long-lived root listener");
assert.equal(element.listenerCount("change"), 1, "the family selector should bind one long-lived change listener");
assert.equal(documentTarget.listenerCount("click"), 1, "outside-click handling should bind once");
controller.render({ sources, activeSourceId: "source-1" });
assert.match(element.innerHTML, /session-item active pinned/);
controller.onChange(changeEvent(targetForFamily("agent:codex")));
assert.equal(selectedFamilies.length, 1);
assert.equal(selectedFamilies[0].sources[0].id, "source-4");
assert.match(element.innerHTML, /Read-only Codex trace/);
controller.render({ sources, activeSourceId: "source-1" });

controller.handleSourceAction("menu", "source-1");
assert.match(element.innerHTML, /data-source-action="pin"/);
controller.handleSourceAction("pin", "source-1");
assert.equal(sourceActions.length, 1);
assert.equal(sourceActions[0].action, "pin");
assert.equal(sourceActions[0].source.id, "source-1");
assert.doesNotMatch(element.innerHTML, /data-source-action="pin"/);

controller.toggleProject(projectKey);
assert.equal(JSON.parse(stored.get("peekmyagent.collapsedProjects"))[projectKey], true);
assert.doesNotMatch(element.innerHTML, /data-source="source-1"/);
controller.toggleProject(projectKey);

controller.handleProjectAction("menu", projectKey);
assert.match(element.innerHTML, /data-project-action="archive"/);
controller.handleProjectAction("archive", projectKey);
assert.equal(projectActions.length, 1);
assert.equal(projectActions[0].projectGroup.sources.length, 2);

controller.onClick(clickEvent(targetFor({ source: "source-1" })));
assert.deepEqual(selected, ["source-1"]);
controller.onClick(clickEvent(targetFor({ source: "source-2" })));
assert.deepEqual(selected, ["source-1"], "unavailable sources must not be selected programmatically");

controller.handleSourceAction("menu", "source-1");
documentTarget.dispatch("click", clickEvent(targetFor({ outside: true })));
assert.doesNotMatch(element.innerHTML, /data-source-action="pin"/, "outside click should close menus");

const controllerSource = fs.readFileSync(new URL("../src/viewer/session-navigator-controller.js", import.meta.url), "utf8");
const modelSource = fs.readFileSync(new URL("../src/viewer/session-navigator-model.js", import.meta.url), "utf8");
const rendererSource = fs.readFileSync(new URL("../src/viewer/session-navigator-renderer.js", import.meta.url), "utf8");
assert.doesNotMatch(modelSource, /\bdocument\b|\bwindow\b|\blocalStorage\b|\bfetch\s*\(|\bstate\./);
assert.doesNotMatch(rendererSource, /\bdocument\b|\bwindow\b|\blocalStorage\b|\bfetch\s*\(|\bstate\./);
assert.doesNotMatch(controllerSource, /\bwindow\b|\blocalStorage\b|\bfetch\s*\(|\bstate\./);

controller.destroy();
assert.equal(element.listenerCount("click"), 0);
assert.equal(element.listenerCount("change"), 0);
assert.equal(documentTarget.listenerCount("click"), 0);
assert.equal(element.innerHTML, "");

console.log("session navigator view contract smoke passed");

function createFakeEventTarget(overrides = {}) {
  const listeners = new Map();
  return {
    innerHTML: "",
    contains: overrides.contains || (() => false),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
}

function targetFor(dataset) {
  return {
    dataset,
    closest(selector) {
      if (selector === "[data-source]" && Object.hasOwn(dataset, "source")) return this;
      return null;
    },
  };
}

function targetForFamily(value) {
  return {
    value,
    dataset: { sourceFamilySelect: "" },
    closest(selector) {
      if (selector === "[data-source-family-select]") return this;
      return null;
    },
  };
}

function changeEvent(target) {
  return { target };
}

function clickEvent(target) {
  return {
    target,
    preventDefault() {},
    stopPropagation() {},
  };
}
