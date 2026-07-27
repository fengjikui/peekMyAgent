#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  containsLazyPayload,
  hydrateLazyPayload,
  isLazyPayload,
} from "../src/contracts/lazy-payload.mjs";
import { loadLazyPayload, projectLazyPayloads } from "../src/server/lazy-payload-service.mjs";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const toolOutput = `${"extracted text ".repeat(500)}TOOL_RESULT_TAIL`;
const ordinaryLongText = `${"ordinary user text ".repeat(500)}USER_TEXT_TAIL`;
const detail = {
  generated_at: "2026-07-27T00:00:00.000Z",
  source: { id: "source-1", label: "source-1", kind: "stored", available: true },
  detail_scope: "request_window",
  request: {
    id: "request-1",
    request_index: 1,
    detail_scope: "request_window",
    raw: {
      body: {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
              { type: "tool_result", tool_use_id: "tool-1", content: toolOutput },
              { type: "text", text: ordinaryLongText },
            ],
          },
        ],
      },
    },
  },
};

const projected = projectLazyPayloads(detail);
const imageMarker = projected.request.raw.body.messages[0].content[0].source.data;
const textMarker = projected.request.raw.body.messages[0].content[1].content;
assert.equal(isLazyPayload(imageMarker), true);
assert.equal(imageMarker.kind, "image");
assert.equal(imageMarker.mime_type, "image/png");
assert.deepEqual([imageMarker.width, imageMarker.height], [1, 1]);
assert.equal(isLazyPayload(textMarker), true);
assert.equal(textMarker.kind, "text");
assert.equal(projected.request.raw.body.messages[0].content[2].text, ordinaryLongText, "ordinary input text remains eager");
assert.equal(JSON.stringify(projected).includes("TOOL_RESULT_TAIL"), false);
assert.equal(JSON.stringify(projected).includes(pngBase64), false);
assert.equal(containsLazyPayload(projected), true);

const imagePayload = loadLazyPayload(detail, imageMarker.ref);
assert.equal(imagePayload.payload.value, pngBase64);
assert.equal(imagePayload.payload.encoding, "base64");
const hydrated = hydrateLazyPayload(projected, imageMarker.ref, imagePayload.payload);
assert.equal(hydrated.request.raw.body.messages[0].content[0].source.data.load_state, "loaded");
assert.equal(hydrated.request.raw.body.messages[0].content[0].source.data.loaded_value, pngBase64);

const textPayload = loadLazyPayload(detail, textMarker.ref);
assert.equal(textPayload.payload.value, toolOutput);
assert.equal(textPayload.payload.encoding, "utf8");

const ordinaryPathRef = Buffer.from(
  JSON.stringify(["request", "raw", "body", "messages", 0, "content", 2, "text"]),
).toString("base64url");
assert.throws(() => loadLazyPayload(detail, ordinaryPathRef), /Lazy payload not found/);
assert.throws(() => loadLazyPayload(detail, "not+base64url"), /Invalid lazy payload ref/);

console.log("lazy payload contract smoke passed");
