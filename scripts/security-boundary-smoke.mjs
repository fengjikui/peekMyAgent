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

    const sameOrigin = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: viewerOrigin,
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

    const exportResponse = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`);
    assert.equal(exportResponse.status, 200, "trace export succeeds");
    assert.equal(exportResponse.headers.get("content-type"), "application/gzip");
    assertSecurityHeaders(exportResponse, "trace export");

    const crossSiteExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(crossSiteExport.status, 403, "cross-site trace export is rejected");

    const fetchMetadataExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(fetchMetadataExport.status, 403, "cross-site Fetch Metadata trace export is rejected");

    const sameOriginExport = await fetch(`${viewer.url}/api/trace/export?source=${encodeURIComponent(startedWatch.id)}`, {
      headers: { "sec-fetch-site": "same-origin", referer: `${viewerOrigin}/` },
    });
    assert.equal(sameOriginExport.status, 200, "same-origin trace export remains accepted");

    const loopbackWrongPort = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: otherLoopbackOrigin,
      },
      body: JSON.stringify({ agent: "Claude Code" }),
    });
    assert.equal(loopbackWrongPort.status, 403, "same-host different-port browser POST is rejected");

    const loopbackWrongRefererPort = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: `${otherLoopbackOrigin}/page`,
      },
      body: JSON.stringify({ agent: "Claude Code" }),
    });
    assert.equal(loopbackWrongRefererPort.status, 403, "same-host different-port Referer POST is rejected");

    const crossSite = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ agent: "Claude Code" }),
    });
    assert.equal(crossSite.status, 403, "cross-site browser POST is rejected");

    const crossSiteReferer = await fetch(`${viewer.url}/api/watch/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: "https://evil.example/page",
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

    const unsafeLanguage = await fetch(`${viewer.url}/api/translations/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_language: "../escape", materials: [] }),
    });
    assert.equal(unsafeLanguage.status, 400, "unsafe path-backed language labels are rejected");

    const tooManyCaptures = await fetch(`${viewer.url}/api/trace/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  const csp = response.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/, `${label} sets a default CSP`);
  assert.match(csp, /frame-ancestors 'none'/, `${label} cannot be framed`);
  assert.match(csp, /object-src 'none'/, `${label} blocks plugins`);
}
