#!/usr/bin/env node
import assert from "node:assert/strict";
import { commonMessagePrefixLength, comparableMessageKey, normalizeComparableValue } from "../src/trace/message-equivalence.mjs";

const plain = { role: "user", content: "hello" };
const block = { role: "user", content: [{ type: "text", text: "hello" }] };
const cached = {
  role: "user",
  content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
  cache_control: { type: "ephemeral" },
};

assert.equal(comparableMessageKey(plain), comparableMessageKey(block), "string and text block content are equivalent");
assert.equal(comparableMessageKey(block), comparableMessageKey(cached), "cache_control does not change message identity");
assert.notEqual(comparableMessageKey(plain), comparableMessageKey({ role: "assistant", content: "hello" }), "role remains part of identity");
assert.notEqual(comparableMessageKey(plain), comparableMessageKey({ role: "user", content: "different" }), "text remains part of identity");

const previous = [plain, { role: "assistant", content: "answer" }, { role: "user", content: "old tail" }];
const current = [cached, { role: "assistant", content: [{ type: "text", text: "answer" }] }, { role: "user", content: "new tail" }];
assert.equal(commonMessagePrefixLength(previous, current), 2);
assert.equal(commonMessagePrefixLength(null, current), 0);
assert.deepEqual(normalizeComparableValue({ value: 1, cache_control: { type: "ephemeral" } }), { value: 1 });

console.log("message equivalence contract smoke passed");
