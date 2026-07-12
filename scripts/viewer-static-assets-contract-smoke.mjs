#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveViewerStaticAsset, viewerStaticAssetPaths } from "../src/server/viewer-static-assets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerDir = path.join(projectRoot, "src", "viewer");
const clientSource = fs.readFileSync(path.join(viewerDir, "client.js"), "utf8");
const browserImports = [...clientSource.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map((match) => `/${match[1]}`);

for (const pathname of ["/", "/styles.css", "/client.js", ...browserImports]) {
  const asset = resolveViewerStaticAsset(pathname, { viewerDir, projectRoot });
  assert.ok(asset, `viewer static asset is not registered: ${pathname}`);
  assert.equal(fs.existsSync(asset.filePath), true, `viewer static asset file is missing: ${asset.filePath}`);
  if (pathname.endsWith(".js")) assert.equal(asset.contentType, "text/javascript; charset=utf-8");
}

assert.equal(resolveViewerStaticAsset("/../../package.json", { viewerDir, projectRoot }), null);
assert.equal(resolveViewerStaticAsset("/not-registered.js", { viewerDir, projectRoot }), null);
assert.equal(new Set(viewerStaticAssetPaths()).size, viewerStaticAssetPaths().length);

console.log(`viewer static assets contract smoke passed (${viewerStaticAssetPaths().length} assets)`);
