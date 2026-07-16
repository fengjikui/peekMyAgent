#!/usr/bin/env node
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  VIEWER_INTENTS,
  expectedApiMethod,
  readJsonBody,
  readRawBody,
  rejectWrongMethod,
  validateLocalHttpRequest,
  validateRequestIntent,
  viewerSecurityHeaders,
  writeJson,
} from "../src/server/http.mjs";

assert.equal(expectedApiMethod("/api/sources"), "GET");
assert.equal(expectedApiMethod("/api/watch/start"), "POST");
assert.equal(expectedApiMethod("/api/not-found"), "");

const sameOriginRequest = request({
  method: "POST",
  headers: {
    host: "127.0.0.1:43110",
    origin: "http://127.0.0.1:43110",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  },
});
assert.equal(validateLocalHttpRequest(sameOriginRequest, new URL("http://peek.local/api/watch/start")), null);
assert.equal(
  validateLocalHttpRequest(request({ headers: { host: "evil.example" } }), new URL("http://peek.local/api/sources"))?.status,
  403,
);
assert.equal(
  validateLocalHttpRequest(
    request({ headers: { host: "127.0.0.1:43110", origin: "http://127.0.0.1:43111" } }),
    new URL("http://peek.local/api/sources"),
  )?.status,
  403,
);
assert.equal(
  validateLocalHttpRequest(request({ method: "POST", headers: { host: "127.0.0.1:43110" } }), new URL("http://peek.local/api/watch/start"))?.status,
  415,
);
assert.equal(
  validateLocalHttpRequest(request({ method: "POST", headers: { host: "127.0.0.1:43110" } }), new URL("http://peek.local/api/sources")),
  null,
  "known wrong methods reach the route-level 405 guard before content-type validation",
);

assert.equal(
  validateRequestIntent(request({ headers: { "x-peekmyagent-intent": VIEWER_INTENTS.watchStart } }), VIEWER_INTENTS.watchStart, "missing"),
  null,
);
assert.equal(validateRequestIntent(request(), VIEWER_INTENTS.watchStart, "missing").status, 403);

assert.deepEqual(await readJsonBody(request({ headers: { "content-type": "application/json" }, body: '{"ok":true}' })), { ok: true });
assert.deepEqual(await readJsonBody(request({ headers: { "content-type": "application/problem+json" }, body: "" })), {});
assert.throws(() => readJsonBody(request({ headers: { "content-type": "text/plain" }, body: "{}" })), /Expected application\/json/);
await assert.rejects(() => readJsonBody(request({ headers: { "content-type": "application/json" }, body: "{" })), SyntaxError);
assert.equal((await readRawBody(request({ body: "trace" }))).toString("utf8"), "trace");

const methodResponse = responseRecorder();
assert.equal(rejectWrongMethod(request({ method: "POST" }), methodResponse, "GET"), true);
assert.equal(methodResponse.status, 405);
assert.equal(methodResponse.headers.allow, "GET");
assert.match(methodResponse.body, /Method POST is not allowed/);

const jsonResponse = responseRecorder();
writeJson(jsonResponse, 201, { ok: true });
assert.equal(jsonResponse.status, 201);
assert.match(jsonResponse.headers["content-security-policy"], /default-src 'self'/);
assert.equal(jsonResponse.headers["x-content-type-options"], "nosniff");
assert.equal(jsonResponse.body, '{\n  "ok": true\n}\n');
assert.equal(viewerSecurityHeaders()["cross-origin-resource-policy"], "same-origin");

console.log("viewer HTTP contract smoke passed");

function request({ method = "GET", headers = {}, body = "" } = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.headers = headers;
  return req;
}

function responseRecorder() {
  return {
    headers: {},
    status: null,
    body: "",
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) this.headers[String(name).toLowerCase()] = value;
    },
    end(value = "") {
      this.body += String(value);
    },
  };
}
