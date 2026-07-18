import assert from "node:assert/strict";
import { buildOrderedRequestTree, reconstructFromRequestTree } from "../src/core/request-tree.mjs";

const baseRequest = {
  model: "claude-code-test",
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.159.aaa" },
    { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    { type: "text", text: "Stable project instructions." },
  ],
  messages: [
    { role: "user", content: "<session>\n第一条消息\n</session>" },
    { role: "assistant", content: [{ type: "text", text: "收到。" }] },
    { role: "tool", tool_call_id: "toolu_1", content: "total 0" },
  ],
  tools: [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
  temperature: 0,
};

const changedRequest = {
  ...baseRequest,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.159.bbb" },
    baseRequest.system[1],
    baseRequest.system[2],
  ],
  messages: [...baseRequest.messages, { role: "user", content: "第二条消息" }],
};

const baseTree = buildOrderedRequestTree(baseRequest, { requestId: "request-1" });
const changedTree = buildOrderedRequestTree(changedRequest, { requestId: "request-2" });

assert.deepEqual(reconstructFromRequestTree(baseTree), baseRequest);
assert.deepEqual(reconstructFromRequestTree(changedTree), changedRequest);

const baseSystem = blobsByKind(baseTree, "system_block");
const changedSystem = blobsByKind(changedTree, "system_block");
assert.equal(baseSystem.length, 3);
assert.equal(changedSystem.length, 3);
assert.notEqual(changedSystem[0].hash, baseSystem[0].hash);
assert.equal(changedSystem[1].hash, baseSystem[1].hash);
assert.equal(changedSystem[2].hash, baseSystem[2].hash);

const baseMessages = blobsByKind(baseTree, "message");
const changedMessages = blobsByKind(changedTree, "message");
assert.equal(baseMessages[0].hash, changedMessages[0].hash);
assert.equal(baseMessages[1].hash, changedMessages[1].hash);
assert.equal(changedMessages.length, 3);

const baseToolResults = blobsByKind(baseTree, "tool_result");
const changedToolResults = blobsByKind(changedTree, "tool_result");
assert.equal(baseToolResults[0].hash, changedToolResults[0].hash);

const baseTools = blobsByKind(baseTree, "tool_schema");
const changedTools = blobsByKind(changedTree, "tool_schema");
assert.equal(baseTools[0].hash, changedTools[0].hash);

const messagesNode = changedTree.nodes.find((node) => node.json_path === "$.messages");
const messageChildren = changedTree.nodes.filter((node) => node.parent_node_id === messagesNode.node_id);
assert.deepEqual(
  messageChildren.map((node) => node.array_index),
  [0, 1, 2, 3],
);

const responsesRequest = {
  model: "gpt-codex-test",
  instructions: "Stable Codex instructions.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect one file." }] },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
    { type: "function_call_output", call_id: "call-1", output: "peekMyAgent" },
  ],
  tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  additional_tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch." }],
};
const changedResponsesRequest = {
  ...responsesRequest,
  input: [
    ...responsesRequest.input,
    { type: "message", role: "user", content: [{ type: "input_text", text: "Now summarize it." }] },
  ],
};
const responsesTree = buildOrderedRequestTree(responsesRequest, { requestId: "responses-1" });
const changedResponsesTree = buildOrderedRequestTree(changedResponsesRequest, { requestId: "responses-2" });

assert.deepEqual(reconstructFromRequestTree(responsesTree), responsesRequest);
assert.deepEqual(reconstructFromRequestTree(changedResponsesTree), changedResponsesRequest);
assert.equal(blobsByKind(responsesTree, "system_block").length, 1);
assert.equal(blobsByKind(responsesTree, "system_block")[0].hash, blobsByKind(changedResponsesTree, "system_block")[0].hash);
assert.equal(blobsByKind(responsesTree, "tool_schema").length, 2);
assert.deepEqual(
  blobsByKind(responsesTree, "tool_schema").map((blob) => blob.hash),
  blobsByKind(changedResponsesTree, "tool_schema").map((blob) => blob.hash),
);
assert.equal(blobsByKind(responsesTree, "message").length, 2);
assert.equal(blobsByKind(responsesTree, "tool_result").length, 1);
assert.deepEqual(
  blobsByKind(responsesTree, "message").map((blob) => blob.hash),
  blobsByKind(changedResponsesTree, "message").slice(0, 2).map((blob) => blob.hash),
);
assert.equal(
  blobsByKind(responsesTree, "tool_result")[0].hash,
  blobsByKind(changedResponsesTree, "tool_result")[0].hash,
);

console.log("request-tree smoke passed");

function blobsByKind(tree, kind) {
  return tree.blobs.filter((blob) => blob.kind === kind);
}
