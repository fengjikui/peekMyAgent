#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_UI_LANGUAGE, translateUi, UI_I18N } from "../src/viewer/ui-i18n.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerDir = path.join(repoRoot, "src", "viewer");
const supportedLanguages = ["zh-CN", "en-US"];

assert.equal(DEFAULT_UI_LANGUAGE, "zh-CN");
assert.deepEqual(Object.keys(UI_I18N).sort(), supportedLanguages.sort());

const defaultKeys = Object.keys(UI_I18N[DEFAULT_UI_LANGUAGE]).sort();
assert.ok(defaultKeys.length >= 350, "the Viewer UI resource set should not be accidentally truncated");

for (const language of supportedLanguages) {
  const dictionary = UI_I18N[language];
  assert.deepEqual(Object.keys(dictionary).sort(), defaultKeys, `${language} must expose the same UI keys as ${DEFAULT_UI_LANGUAGE}`);
  for (const [key, value] of Object.entries(dictionary)) {
    assert.equal(typeof value, "string", `${language}.${key} must be a string`);
    assert.notEqual(value.trim(), "", `${language}.${key} must not be empty`);
    assert.deepEqual(
      placeholders(value),
      placeholders(UI_I18N[DEFAULT_UI_LANGUAGE][key]),
      `${language}.${key} must preserve the same placeholders as ${DEFAULT_UI_LANGUAGE}`,
    );
  }
}

assert.equal(translateUi("en-US", "requestUnit", { count: 3 }), "3 requests");
assert.equal(translateUi("zh-CN", "requestUnit", { count: 3 }), "3 请求");
assert.equal(translateUi("unknown", "requestUnit", { count: 2 }), "2 请求");
assert.equal(translateUi("en-US", "missingUiKey"), "missingUiKey");
assert.equal(translateUi("en-US", "requestUnit"), " requests");

const sourceFiles = fs
  .readdirSync(viewerDir)
  .filter((file) => file.endsWith(".js") && file !== "ui-i18n.js")
  .map((file) => path.join(viewerDir, file));
const referencedKeys = new Map();
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  collectMatches(referencedKeys, source, /\b(?:t|translate)\(\s*["']([^"']+)["']/g, path.relative(repoRoot, file));
}

const htmlPath = path.join(viewerDir, "index.html");
collectMatches(
  referencedKeys,
  fs.readFileSync(htmlPath, "utf8"),
  /\bdata-i18n(?:-title|-aria-label)?=["']([^"']+)["']/g,
  path.relative(repoRoot, htmlPath),
);

const missingReferences = [...referencedKeys.entries()]
  .filter(([key]) => !(key in UI_I18N[DEFAULT_UI_LANGUAGE]))
  .map(([key, files]) => `${key} (${[...files].sort().join(", ")})`);
assert.deepEqual(missingReferences, [], `static Viewer i18n references must exist:\n${missingReferences.join("\n")}`);

const clientSource = fs.readFileSync(path.join(viewerDir, "client.js"), "utf8");
const languageControllerSource = fs.readFileSync(path.join(viewerDir, "language-preferences-controller.js"), "utf8");
assert.match(clientSource, /import\s+\{\s*LanguagePreferencesController\s*\}\s+from\s+["']\.\/language-preferences-controller\.js["']/);
assert.match(languageControllerSource, /import\s+\{\s*translateUi\s*\}\s+from\s+["']\.\/ui-i18n\.js["']/);
assert.doesNotMatch(clientSource, /\bconst\s+I18N\s*=/, "the application assembly must not own the UI resource dictionary");
assert.match(clientSource, /function\s+t\(key,\s*vars\s*=\s*\{\}\)\s*\{\s*return\s+languagePreferencesController\.translate\(key,\s*vars\);\s*\}/s);

const translateSource = translateUi.toString();
assert.doesNotMatch(translateSource, /\bdocument\b|\bwindow\b|\bfetch\s*\(|\bstate\./);

console.log(`viewer i18n contract smoke passed (${defaultKeys.length} keys, ${referencedKeys.size} static references)`);

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function collectMatches(target, source, pattern, file) {
  for (const match of source.matchAll(pattern)) {
    const key = match[1];
    if (!target.has(key)) target.set(key, new Set());
    target.get(key).add(file);
  }
}
