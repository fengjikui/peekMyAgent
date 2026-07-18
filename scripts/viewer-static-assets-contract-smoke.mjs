#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveViewerStaticAsset, viewerStaticAssetPaths } from "../src/server/viewer-static-assets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerDir = path.join(projectRoot, "src", "viewer");
const pending = ["/client.js"];
const browserModules = new Set();
while (pending.length) {
  const pathname = pending.shift();
  if (browserModules.has(pathname)) continue;
  browserModules.add(pathname);
  const asset = resolveViewerStaticAsset(pathname, { viewerDir, projectRoot });
  assert.ok(asset, `viewer static asset is not registered: ${pathname}`);
  assert.equal(fs.existsSync(asset.filePath), true, `viewer static asset file is missing: ${asset.filePath}`);
  assert.equal(asset.contentType, "text/javascript; charset=utf-8");
  const source = fs.readFileSync(asset.filePath, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)) {
    if (!match[1].startsWith(".")) continue;
    pending.push(new URL(match[1], `http://viewer.local${pathname}`).pathname);
  }
}

for (const pathname of ["/", "/styles.css"]) {
  const asset = resolveViewerStaticAsset(pathname, { viewerDir, projectRoot });
  assert.ok(asset, `viewer static asset is not registered: ${pathname}`);
  assert.equal(fs.existsSync(asset.filePath), true, `viewer static asset file is missing: ${asset.filePath}`);
}

assert.equal(resolveViewerStaticAsset("/../../package.json", { viewerDir, projectRoot }), null);
assert.equal(resolveViewerStaticAsset("/not-registered.js", { viewerDir, projectRoot }), null);
assert.equal(new Set(viewerStaticAssetPaths()).size, viewerStaticAssetPaths().length);

console.log(`viewer static assets contract smoke passed (${browserModules.size} transitive modules; ${viewerStaticAssetPaths().length} registered assets)`);
