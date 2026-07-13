import path from "node:path";

const VIEWER_STATIC_ASSETS = new Map([
  ["/", { base: "viewer", file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/styles.css", { base: "viewer", file: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/api-client.js", javascriptAsset("api-client.js")],
  ["/client-store.js", javascriptAsset("client-store.js")],
  ["/client.js", javascriptAsset("client.js")],
  ["/markdown.js", javascriptAsset("markdown.js")],
  ["/message-view-model.js", javascriptAsset("message-view-model.js")],
  ["/messages-renderer.js", javascriptAsset("messages-renderer.js")],
  ["/raw-inspector-renderer.js", javascriptAsset("raw-inspector-renderer.js")],
  ["/raw-search-controller.js", javascriptAsset("raw-search-controller.js")],
  ["/raw-search-model.js", javascriptAsset("raw-search-model.js")],
  ["/raw-view-model.js", javascriptAsset("raw-view-model.js")],
  ["/request-detail-cache.js", javascriptAsset("request-detail-cache.js")],
  ["/translation-renderer.js", javascriptAsset("translation-renderer.js")],
  ["/translation-view-model.js", javascriptAsset("translation-view-model.js")],
  ["/trace-timeline-controller.js", javascriptAsset("trace-timeline-controller.js")],
  ["/trace-timeline-model.js", javascriptAsset("trace-timeline-model.js")],
  ["/trace-timeline-renderer.js", javascriptAsset("trace-timeline-renderer.js")],
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
