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
