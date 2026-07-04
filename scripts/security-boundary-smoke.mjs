import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startViewerServer } from "../src/viewer/server.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peek-security-boundary-"));
const storePath = path.join(tmp, "store.sqlite");

try {
  await assert.rejects(
    () => startViewerServer({ cwd: process.cwd(), storePath, host: "0.0.0.0" }),
    /Refusing to bind peekMyAgent to non-loopback host/,
  );

  const viewer = await startViewerServer({ cwd: process.cwd(), storePath });
  try {
    const viewerOrigin = new URL(viewer.url).origin;
    const viewerUrl = new URL(viewer.url);
    const otherLoopbackOrigin = `http://${viewerUrl.hostname}:${Number(viewerUrl.port) + 1}`;

    const index = await fetch(viewer.url);
    assert.equal(index.status, 200, "dashboard index loads");
    assertSecurityHeaders(index, "dashboard index");

    const sources = await fetch(`${viewer.url}/api/sources`);
    assert.equal(sources.status, 200, "sources API loads");
    assertSecurityHeaders(sources, "JSON API");

    const postSources = await fetch(`${viewer.url}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(postSources.status, 405, "read-only sources API rejects POST");
    assert.equal(postSources.headers.get("allow"), "GET", "read-only sources API advertises GET");

    const postSourcesWithoutJson = await fetch(`${viewer.url}/api/sources`, { method: "POST" });
    assert.equal(postSourcesWithoutJson.status, 405, "read-only sources API rejects POST before JSON content-type checks");

    const dashboardStyleSources = await fetch(`${viewer.url}/api/sources`, {
      headers: {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        referer: `${viewerOrigin}/`,
      },
    });
    assert.equal(dashboardStyleSources.status, 200, "same-origin dashboard fetch shape is accepted");

    const resourceShapeSources = await fetch(`${viewer.url}/api/sources`, {
      headers: { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
    });
    assert.equal(resourceShapeSources.status, 403, "browser resource-shaped API GET is rejected");

    const navigationShapeSources = await fetch(`${viewer.url}/api/sources`, {
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    assert.equal(navigationShapeSources.status, 403, "browser navigation-shaped API GET is rejected");

    const noIntentWatchStart = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: viewerOrigin,
      },
      body: JSON.stringify({
        agent: "Claude Code",
        target_base_url: "http://127.0.0.1:9",
        workspace: process.cwd(),
        conversation_id: "no-intent-watch-start-security-smoke",
      }),
    });
    assert.equal(noIntentWatchStart.status, 403, "watch start without explicit wrapper intent is rejected");

    const sameOrigin = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: viewerOrigin,
        "x-peekmyagent-intent": "watch-start",
      },
      body: JSON.stringify({
        agent: "Claude Code",
        target_base_url: "http://127.0.0.1:9",
        workspace: process.cwd(),
        conversation_id: "same-origin-security-smoke",
      }),
    });
    assert.equal(sameOrigin.status, 200, "same dashboard origin POST is accepted");
    const startedWatch = await sameOrigin.json();

    const noIntentWatchPause = await fetch(`${viewer.url}/api/watch/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: startedWatch.id, status: "paused" }),
    });
    assert.equal(noIntentWatchPause.status, 403, "watch pause without explicit dashboard or CLI intent is rejected");

    const noIntentWatchStop = await fetch(`${viewer.url}/api/watch/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: startedWatch.id, clear: false }),
    });
    assert.equal(noIntentWatchStop.status, 403, "watch stop without explicit dashboard or CLI intent is rejected");

    const defaultView = await fetch(`${viewer.url}/api/view`);
    assert.equal(defaultView.status, 200, "view API without source may still open the default source");

    const postView = await fetch(`${viewer.url}/api/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(postView.status, 405, "read-only view API rejects POST");
    assert.equal(postView.headers.get("allow"), "GET", "read-only view API advertises GET");

    const postRequest = await fetch(`${viewer.url}/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(postRequest.status, 405, "read-only request detail API rejects POST");

    const unknownView = await fetch(`${viewer.url}/api/view?source=missing-trace-source`);
    assert.equal(unknownView.status, 404, "view API rejects unknown explicit sources instead of falling back");

    const unknownRequestDetail = await fetch(`${viewer.url}/api/request?source=missing-trace-source&request=req_1`);
    assert.equal(unknownRequestDetail.status, 404, "request detail API rejects unknown explicit sources instead of falling back");

    const longUnknownSourceId = `missing-source\n${"x".repeat(2000)}`;
    const longUnknownView = await fetch(`${viewer.url}/api/view?source=${encodeURIComponent(longUnknownSourceId)}`);
    assert.equal(longUnknownView.status, 404, "view API rejects long unknown sources");
    const longUnknownViewJson = await longUnknownView.json();
    assert.equal(longUnknownViewJson.error.length < 700, true, "view API does not echo unbounded source ids");
    assert.equal(/[\x00-\x1F\x7F]/.test(longUnknownViewJson.error), false, "view API strips control characters from source errors");

    const longUnknownRequest = await fetch(`${viewer.url}/api/request?source=${encodeURIComponent(startedWatch.id)}&request=${encodeURIComponent(`req\n${"x".repeat(2000)}`)}`);
    assert.equal(longUnknownRequest.status, 404, "request detail rejects long unknown request ids");
    const longUnknownRequestJson = await longUnknownRequest.json();
    assert.equal(longUnknownRequestJson.error.length < 380, true, "request detail does not echo unbounded request ids");
    assert.equal(/[\x00-\x1F\x7F]/.test(longUnknownRequestJson.error), false, "request detail strips control characters from request id errors");

    const noIntentTranslationGenerate = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_language: "zh-CN", materials: [] }),
    });
    assert.equal(noIntentTranslationGenerate.status, 403, "translation generation without explicit dashboard intent is rejected");

    const unknownTranslationSource = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
      body: JSON.stringify({ source_id: "missing-trace-source", target_language: "zh-CN", section: "tools" }),
    });
    assert.equal(unknownTranslationSource.status, 404, "translation refresh rejects unknown explicit sources instead of falling back");

    const noIntentExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { "sec-fetch-site": "same-origin", referer: `${viewerOrigin}/` },
    });
    assert.equal(noIntentExport.status, 403, "trace export without explicit dashboard intent is rejected");

    const postExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "trace-export" },
      body: "{}",
    });
    assert.equal(postExport.status, 405, "trace export rejects POST");
    assert.equal(postExport.headers.get("allow"), "GET", "trace export advertises GET");

    const exportResponse = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { "x-peekmyagent-intent": "trace-export" },
    });
    assert.equal(exportResponse.status, 200, "trace export succeeds");
    assert.equal(exportResponse.headers.get("content-type"), "application/gzip");
    assertSecurityHeaders(exportResponse, "trace export");

    const missingSourceExport = await fetch(`${viewer.url}/api/trace/export`, {
      headers: { "x-peekmyagent-intent": "trace-export" },
    });
    assert.equal(missingSourceExport.status, 400, "trace export requires an explicit source id");

    const unknownSourceExport = await fetch(`${viewer.url}/api/trace/export?source=missing-trace-source`, {
      headers: { "x-peekmyagent-intent": "trace-export" },
    });
    assert.equal(unknownSourceExport.status, 404, "trace export rejects unknown sources instead of falling back");

    const longUnknownSourceExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(longUnknownSourceId)}`, {
      headers: { "x-peekmyagent-intent": "trace-export" },
    });
    assert.equal(longUnknownSourceExport.status, 404, "trace export rejects long unknown sources");
    const longUnknownSourceExportJson = await longUnknownSourceExport.json();
    assert.equal(longUnknownSourceExportJson.error.length < 700, true, "trace export does not echo unbounded source ids");
    assert.equal(/[\x00-\x1F\x7F]/.test(longUnknownSourceExportJson.error), false, "trace export strips control characters from source errors");

    const crossSiteExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { origin: "https://evil.example", "x-peekmyagent-intent": "trace-export" },
    });
    assert.equal(crossSiteExport.status, 403, "cross-site trace export is rejected");

    const fetchMetadataExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(fetchMetadataExport.status, 403, "cross-site Fetch Metadata trace export is rejected");

    const sameOriginExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { "sec-fetch-site": "same-origin", referer: `${viewerOrigin}/`, "x-peekmyagent-intent": "trace-export" },
    });
    assert.equal(sameOriginExport.status, 200, "same-origin trace export remains accepted");

    const getWatchStart = await fetch(`${viewer.url}/api/watch/start`);
    assert.equal(getWatchStart.status, 405, "state-changing watch start API rejects GET");
    assert.equal(getWatchStart.headers.get("allow"), "POST", "state-changing watch start API advertises POST");

    const putWatchStart = await fetch(`${viewer.url}/api/watch/start`, { method: "PUT" });
    assert.equal(putWatchStart.status, 405, "state-changing watch start API rejects unsupported state-changing methods before JSON content-type checks");

    const loopbackWrongPort = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: otherLoopbackOrigin,
        "x-peekmyagent-intent": "watch-start",
      },
      body: JSON.stringify({ agent: "Claude Code" }),
    });
    assert.equal(loopbackWrongPort.status, 403, "same-host different-port browser POST is rejected");

    const loopbackWrongRefererPort = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: `${otherLoopbackOrigin}/page`,
        "x-peekmyagent-intent": "watch-start",
      },
      body: JSON.stringify({ agent: "Claude Code" }),
    });
    assert.equal(loopbackWrongRefererPort.status, 403, "same-host different-port Referer POST is rejected");

    const crossSite = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "x-peekmyagent-intent": "watch-start",
      },
      body: JSON.stringify({ agent: "Claude Code" }),
    });
    assert.equal(crossSite.status, 403, "cross-site browser POST is rejected");

    const crossSiteReferer = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: "https://evil.example/page",
        "x-peekmyagent-intent": "watch-start",
      },
      body: JSON.stringify({ agent: "Claude Code" }),
    });
    assert.equal(crossSiteReferer.status, 403, "cross-site Referer POST is rejected");

    const simplePost = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "agent=Claude Code",
    });
    assert.equal(simplePost.status, 415, "simple non-JSON state-changing POST is rejected");

    const bodylessShutdown = await fetch(`${viewer.url}/api/daemon/shutdown`, { method: "POST" });
    assert.equal(bodylessShutdown.status, 415, "daemon shutdown requires explicit JSON content type");

    const noIntentShutdown = await fetch(`${viewer.url}/api/daemon/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noIntentShutdown.status, 403, "daemon shutdown without explicit local CLI intent is rejected");

    const noIntentAgentSend = await fetch(`${viewer.url}/api/agent/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_id: startedWatch.id, message: "should not send without explicit intent" }),
    });
    assert.equal(noIntentAgentSend.status, 403, "agent send without explicit dashboard intent is rejected");

    const noIntentOtelIngest = await fetch(`${viewer.url}/api/capture/otel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: tmp, watch_id: "security-boundary-otel" }),
    });
    assert.equal(noIntentOtelIngest.status, 403, "OTel ingest without explicit local wrapper intent is rejected");

    const noIntentSourceUpdate = await fetch(`${viewer.url}/api/source/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: longUnknownSourceId, title: "ignored" }),
    });
    assert.equal(noIntentSourceUpdate.status, 403, "source update without explicit dashboard intent is rejected");

    const longUnknownSourceUpdate = await fetch(`${viewer.url}/api/source/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "source-update" },
      body: JSON.stringify({ id: longUnknownSourceId, title: "ignored" }),
    });
    assert.equal(longUnknownSourceUpdate.status, 404, "source update rejects long unknown sources");
    const longUnknownSourceUpdateJson = await longUnknownSourceUpdate.json();
    assert.equal(longUnknownSourceUpdateJson.error.length < 700, true, "source update does not echo unbounded source ids");
    assert.equal(/[\x00-\x1F\x7F]/.test(longUnknownSourceUpdateJson.error), false, "source update strips control characters from source errors");

    const unsafeLanguage = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
      body: JSON.stringify({ target_language: "../escape", materials: [] }),
    });
    assert.equal(unsafeLanguage.status, 400, "unsafe path-backed language labels are rejected");

    const unsafeAgentCache = await fetch(`${viewer.url}/api/translations?agent=${encodeURIComponent("..")}&target_language=zh-CN`);
    assert.equal(unsafeAgentCache.status, 200, "translation cache lookup tolerates unsafe-looking agent labels");
    const unsafeAgentCacheJson = await unsafeAgentCache.json();
    assert.equal(unsafeAgentCacheJson.cache_slug, "agent", "unsafe-looking agent label is normalized to a safe slug");
    assert.equal(Object.hasOwn(unsafeAgentCacheJson, "cache_path"), false, "translation cache lookup does not expose local cache paths");

    const noisyLongAgent = `  Claude\nCode\t${"x".repeat(500)}  `;
    const noisyLongAgentCache = await fetch(`${viewer.url}/api/translations?agent=${encodeURIComponent(noisyLongAgent)}&target_language=zh-CN`);
    assert.equal(noisyLongAgentCache.status, 200, "translation cache lookup accepts noisy agent labels");
    const noisyLongAgentCacheJson = await noisyLongAgentCache.json();
    assert.equal(noisyLongAgentCacheJson.agent.length <= 80, true, "translation cache agent label is bounded before API echo");
    assert.equal(/[\x00-\x1F\x7F]/.test(noisyLongAgentCacheJson.agent), false, "translation cache agent label strips control characters");

    const longMissingSource = `missing-source\n${"x".repeat(2000)}`;
    const longMissingTranslationSource = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
      body: JSON.stringify({ source_id: longMissingSource, target_language: "zh-CN", section: "tools" }),
    });
    assert.equal(longMissingTranslationSource.status, 404, "long unknown translation source is rejected before model calls");
    const longMissingTranslationJson = await longMissingTranslationSource.json();
    assert.equal(longMissingTranslationJson.error.length < 700, true, "unknown source error does not echo unbounded source ids");
    assert.equal(/[\x00-\x1F\x7F]/.test(longMissingTranslationJson.error), false, "unknown source error strips control characters");

    const tooManyTranslationMaterials = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
      body: JSON.stringify({
        target_language: "zh-CN",
        materials: Array.from({ length: 1501 }, (_, index) => ({
          kind: "manual_text",
          source_text: `unique translation material ${index}`,
        })),
      }),
    });
    assert.equal(tooManyTranslationMaterials.status, 413, "too many translation materials are rejected before model calls");

    const oversizedTranslationMaterial = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
      body: JSON.stringify({
        target_language: "zh-CN",
        materials: [{ kind: "manual_text", source_text: "x".repeat(200001) }],
      }),
    });
    assert.equal(oversizedTranslationMaterial.status, 413, "oversized translation material is rejected before model calls");

    const oversizedTranslationBatch = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "translation-generate" },
      body: JSON.stringify({
        target_language: "zh-CN",
        materials: Array.from({ length: 1001 }, (_, index) => ({
          kind: "manual_text",
          source_text: `${String(index).padStart(4, "0")} ${"x".repeat(1996)}`,
        })),
      }),
    });
    assert.equal(oversizedTranslationBatch.status, 413, "oversized translation batch is rejected before model calls");

    const noIntentTraceImport = await fetch(`${viewer.url}/api/trace/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        format: "peekmyagent.trace.v1",
        captures: [
          {
            capture_id: "no-intent-import",
            watch_id: "security",
            request_index: 1,
            body: { messages: [] },
          },
        ],
      }),
    });
    assert.equal(noIntentTraceImport.status, 403, "trace import without explicit dashboard intent is rejected");

    const tooManyCaptures = await fetch(`${viewer.url}/api/trace/import`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "trace-import" },
      body: JSON.stringify({
        format: "peekmyagent.trace.v1",
        captures: Array.from({ length: 5001 }, (_, index) => ({
          capture_id: `cap-${index}`,
          watch_id: "security",
          request_index: index + 1,
          body: { messages: [] },
        })),
      }),
    });
    assert.equal(tooManyCaptures.status, 413, "oversized trace capture count is rejected");

    const noisyTraceTitle = `  imported\ntrace\u0000with\u007fcontrols ${"x".repeat(200)}  `;
    const sanitizedTitleImport = await fetch(`${viewer.url}/api/trace/import`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peekmyagent-intent": "trace-import" },
      body: JSON.stringify({
        format: "peekmyagent.trace.v1",
        manifest: { trace_id: "title-sanitize-smoke", title: noisyTraceTitle },
        captures: [
          {
            capture_id: "title-sanitize-capture",
            watch_id: "security",
            request_index: 1,
            body: { messages: [{ role: "user", content: "import title sanitize smoke" }] },
          },
        ],
      }),
    });
    assert.equal(sanitizedTitleImport.status, 200, "trace import with noisy manifest title succeeds");
    const sanitizedTitleImportJson = await sanitizedTitleImport.json();
    assert.equal(/[\x00-\x1F\x7F]/.test(sanitizedTitleImportJson.source.label), false, "imported trace title is stripped of control characters");
    assert.equal(sanitizedTitleImportJson.source.label.length <= 120, true, "imported trace title is bounded before entering source list");
  } finally {
    await viewer.close();
  }
  console.log("security-boundary smoke: OK");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function assertSecurityHeaders(response, label) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${label} sets nosniff`);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer", `${label} sets referrer policy`);
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin", `${label} sets COOP`);
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin", `${label} sets CORP`);
  const permissionsPolicy = response.headers.get("permissions-policy") || "";
  assert.match(permissionsPolicy, /camera=\(\)/, `${label} disables camera access`);
  assert.match(permissionsPolicy, /microphone=\(\)/, `${label} disables microphone access`);
  assert.match(permissionsPolicy, /geolocation=\(\)/, `${label} disables geolocation access`);
  assert.match(permissionsPolicy, /usb=\(\)/, `${label} disables USB access`);
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/, `${label} sets a default CSP`);
  assert.match(csp, /frame-ancestors 'none'/, `${label} cannot be framed`);
  assert.match(csp, /object-src 'none'/, `${label} blocks plugins`);
}
