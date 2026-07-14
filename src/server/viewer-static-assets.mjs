import path from "node:path";

const VIEWER_STATIC_ASSETS = new Map([
  ["/", { base: "viewer", file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/styles.css", { base: "viewer", file: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/agent-composer-controller.js", javascriptAsset("agent-composer-controller.js")],
  ["/agent-composer-model.js", javascriptAsset("agent-composer-model.js")],
  ["/agent-composer-renderer.js", javascriptAsset("agent-composer-renderer.js")],
  ["/agent-graph-model.js", javascriptAsset("agent-graph-model.js")],
  ["/agent-graph-renderer.js", javascriptAsset("agent-graph-renderer.js")],
  ["/api-client.js", javascriptAsset("api-client.js")],
  ["/client-store.js", javascriptAsset("client-store.js")],
  ["/client.js", javascriptAsset("client.js")],
  ["/language-preferences-controller.js", javascriptAsset("language-preferences-controller.js")],
  ["/markdown.js", javascriptAsset("markdown.js")],
  ["/message-view-model.js", javascriptAsset("message-view-model.js")],
  ["/messages-renderer.js", javascriptAsset("messages-renderer.js")],
  ["/pane-layout-controller.js", javascriptAsset("pane-layout-controller.js")],
  ["/pane-layout-model.js", javascriptAsset("pane-layout-model.js")],
  ["/raw-inspector-controller.js", javascriptAsset("raw-inspector-controller.js")],
  ["/raw-inspector-renderer.js", javascriptAsset("raw-inspector-renderer.js")],
  ["/raw-search-controller.js", javascriptAsset("raw-search-controller.js")],
  ["/raw-search-model.js", javascriptAsset("raw-search-model.js")],
  ["/raw-view-model.js", javascriptAsset("raw-view-model.js")],
  ["/request-card-renderer.js", javascriptAsset("request-card-renderer.js")],
  ["/request-card-model.js", javascriptAsset("request-card-model.js")],
  ["/request-detail-cache.js", javascriptAsset("request-detail-cache.js")],
  ["/session-navigator-controller.js", javascriptAsset("session-navigator-controller.js")],
  ["/session-navigator-model.js", javascriptAsset("session-navigator-model.js")],
  ["/session-navigator-renderer.js", javascriptAsset("session-navigator-renderer.js")],
  ["/source-timeline-controller.js", javascriptAsset("source-timeline-controller.js")],
  ["/system-diff-model.js", javascriptAsset("system-diff-model.js")],
  ["/system-diff-renderer.js", javascriptAsset("system-diff-renderer.js")],
  ["/translation-cache-controller.js", javascriptAsset("translation-cache-controller.js")],
  ["/translation-action-controller.js", javascriptAsset("translation-action-controller.js")],
  ["/translation-action-model.js", javascriptAsset("translation-action-model.js")],
  ["/translation-generation-operation.js", javascriptAsset("translation-generation-operation.js")],
  ["/translation-language-catalog.js", javascriptAsset("translation-language-catalog.js")],
  ["/translation-renderer.js", javascriptAsset("translation-renderer.js")],
  ["/translation-view-model.js", javascriptAsset("translation-view-model.js")],
  ["/trace-timeline-controller.js", javascriptAsset("trace-timeline-controller.js")],
  ["/trace-timeline-model.js", javascriptAsset("trace-timeline-model.js")],
  ["/trace-timeline-renderer.js", javascriptAsset("trace-timeline-renderer.js")],
  ["/timeline-entity-store.js", javascriptAsset("timeline-entity-store.js")],
  ["/ui-i18n.js", javascriptAsset("ui-i18n.js")],
  ["/upstream-detail-model.js", javascriptAsset("upstream-detail-model.js")],
  ["/upstream-detail-renderer.js", javascriptAsset("upstream-detail-renderer.js")],
  ["/turn-rail.js", javascriptAsset("turn-rail.js")],
  [
    "/translation-blocks.js",
    { base: "project", file: path.join("src", "translation", "blocks.mjs"), contentType: "text/javascript; charset=utf-8" },
  ],
]);

export function resolveViewerStaticAsset(pathname, { viewerDir, projectRoot }) {
  const asset = VIEWER_STATIC_ASSETS.get(pathname);
  if (!asset) return null;
  const baseDir = asset.base === "project" ? projectRoot : viewerDir;
  return {
    filePath: path.join(baseDir, asset.file),
    contentType: asset.contentType,
  };
}

export function viewerStaticAssetPaths() {
  return [...VIEWER_STATIC_ASSETS.keys()];
}

function javascriptAsset(file) {
  return { base: "viewer", file, contentType: "text/javascript; charset=utf-8" };
}
