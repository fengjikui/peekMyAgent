"use strict";

const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const paths = parsePaths(process.env.PEEKMYAGENT_CODEBUDDY_MODEL_CONFIG_PATHS);
const modelId = String(process.env.PEEKMYAGENT_CODEBUDDY_PROXY_MODEL || "").trim();
const proxyUrl = String(process.env.PEEKMYAGENT_CODEBUDDY_PROXY_URL || "").trim();

delete process.env.PEEKMYAGENT_CODEBUDDY_MODEL_CONFIG_PATHS;
delete process.env.PEEKMYAGENT_CODEBUDDY_PROXY_MODEL;
delete process.env.PEEKMYAGENT_CODEBUDDY_PROXY_URL;

if (paths.size && modelId && proxyUrl) {
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function peekMyAgentReadFileSync(filename, options) {
    const value = readFileSync.call(this, filename, options);
    return rewriteSelectedConfig(filename, value);
  };

  const readFile = fs.readFile;
  fs.readFile = function peekMyAgentReadFile(filename, options, callback) {
    const done = typeof options === "function" ? options : callback;
    const readOptions = typeof options === "function" ? undefined : options;
    if (typeof done !== "function") return readFile.call(this, filename, options, callback);
    return readFile.call(this, filename, readOptions, (error, value) => {
      done(error, error ? value : rewriteSelectedConfig(filename, value));
    });
  };

  const readFilePromise = fsPromises.readFile;
  fsPromises.readFile = async function peekMyAgentReadFilePromise(filename, options) {
    const value = await readFilePromise.call(this, filename, options);
    return rewriteSelectedConfig(filename, value);
  };
}

function rewriteSelectedConfig(filename, value) {
  return paths.has(normalizeFilename(filename)) ? rewriteModelUrl(value, modelId, proxyUrl) : value;
}

function parsePaths(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(normalizeFilename).filter(Boolean));
  } catch {
    return new Set();
  }
}

function normalizeFilename(value) {
  try {
    const filename = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : String(value || "");
    if (!filename) return null;
    const resolved = path.resolve(filename);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

function rewriteModelUrl(value, selectedModel, url) {
  const wasBuffer = Buffer.isBuffer(value);
  const text = wasBuffer ? value.toString("utf8") : String(value);
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return value;
  }
  const models = Array.isArray(config) ? config : Array.isArray(config?.models) ? config.models : [];
  let changed = false;
  for (const model of models) {
    if (!model || typeof model !== "object" || String(model.id || "") !== selectedModel) continue;
    model.url = url;
    changed = true;
  }
  if (!changed) return value;
  const rewritten = `${JSON.stringify(config, null, 2)}\n`;
  return wasBuffer ? Buffer.from(rewritten, "utf8") : rewritten;
}
