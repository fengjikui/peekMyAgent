import crypto from "node:crypto";

const ROOT_PATH = "$";

export function buildOrderedRequestTree(value, { requestId = "request" } = {}) {
  const context = {
    nextNodeId: 1,
    nodes: [],
    blobs: new Map(),
    requestId,
  };
  const rootNodeId = appendNode(context, {
    parent_node_id: null,
    node_type: Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : "scalar",
    object_key: null,
    array_index: null,
    order_index: 0,
    json_path: ROOT_PATH,
    scalar_json: isScalar(value) ? JSON.stringify(value) : null,
    blob_hash: null,
  });
  if (!isScalar(value)) appendChildren(context, value, rootNodeId, ROOT_PATH);
  return {
    request_id: requestId,
    root_node_id: rootNodeId,
    nodes: context.nodes,
    blobs: [...context.blobs.values()],
  };
}

export function reconstructFromRequestTree(tree) {
  const nodes = new Map(tree.nodes.map((node) => [node.node_id, node]));
  const blobs = new Map(tree.blobs.map((blob) => [blob.hash, blob]));
  const childrenByParent = new Map();
  for (const node of tree.nodes) {
    if (!node.parent_node_id) continue;
    if (!childrenByParent.has(node.parent_node_id)) childrenByParent.set(node.parent_node_id, []);
    childrenByParent.get(node.parent_node_id).push(node);
  }
  return reconstructNode(tree.root_node_id, nodes, blobs, childrenByParent);
}

export function blobHash(kind, payloadJson) {
  return crypto.createHash("sha256").update(`${kind}\0${payloadJson}`).digest("hex");
}

function appendChildren(context, value, parentNodeId, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendValue(context, item, parentNodeId, null, index, index, `${path}[${index}]`));
    return;
  }
  Object.entries(value || {}).forEach(([key, item], index) => {
    appendValue(context, item, parentNodeId, key, null, index, `${path}.${escapePathKey(key)}`);
  });
}

function appendValue(context, value, parentNodeId, objectKey, arrayIndex, orderIndex, path) {
  const blockKind = blockKindForValue(value, path);
  if (blockKind) {
    const payloadJson = JSON.stringify(value);
    const hash = blobHash(blockKind, payloadJson);
    if (!context.blobs.has(hash)) {
      context.blobs.set(hash, {
        hash,
        kind: blockKind,
        content_type: "json",
        payload_json: payloadJson,
        byte_size: Buffer.byteLength(payloadJson),
      });
    }
    appendNode(context, {
      parent_node_id: parentNodeId,
      node_type: "blob_ref",
      object_key: objectKey,
      array_index: arrayIndex,
      order_index: orderIndex,
      json_path: path,
      scalar_json: null,
      blob_hash: hash,
    });
    return;
  }

  const nodeType = Array.isArray(value) ? "array" : value && typeof value === "object" ? "object" : "scalar";
  const nodeId = appendNode(context, {
    parent_node_id: parentNodeId,
    node_type: nodeType,
    object_key: objectKey,
    array_index: arrayIndex,
    order_index: orderIndex,
    json_path: path,
    scalar_json: nodeType === "scalar" ? JSON.stringify(value) : null,
    blob_hash: null,
  });
  if (nodeType !== "scalar") appendChildren(context, value, nodeId, path);
}

function appendNode(context, node) {
  const nodeId = `n${context.nextNodeId}`;
  context.nextNodeId += 1;
  context.nodes.push({
    request_id: context.requestId,
    node_id: nodeId,
    ...node,
  });
  return nodeId;
}

function reconstructNode(nodeId, nodes, blobs, childrenByParent) {
  const node = nodes.get(nodeId);
  if (!node) throw new Error(`Missing request tree node: ${nodeId}`);
  if (node.node_type === "blob_ref") {
    const blob = blobs.get(node.blob_hash);
    if (!blob) throw new Error(`Missing content blob: ${node.blob_hash}`);
    return JSON.parse(blob.payload_json);
  }
  if (node.node_type === "scalar") return JSON.parse(node.scalar_json);
  const children = [...(childrenByParent.get(nodeId) || [])].sort(compareChildOrder);
  if (node.node_type === "array") return children.map((child) => reconstructNode(child.node_id, nodes, blobs, childrenByParent));
  if (node.node_type === "object") {
    const output = {};
    for (const child of children) output[child.object_key] = reconstructNode(child.node_id, nodes, blobs, childrenByParent);
    return output;
  }
  throw new Error(`Unsupported request tree node type: ${node.node_type}`);
}

function compareChildOrder(left, right) {
  if (left.array_index !== null || right.array_index !== null) return Number(left.array_index ?? 0) - Number(right.array_index ?? 0);
  return Number(left.order_index ?? 0) - Number(right.order_index ?? 0);
}

function blockKindForValue(value, path) {
  if (path === "$.system" && !Array.isArray(value)) return "system_block";
  if (/^\$\.system\[\d+\]$/.test(path)) return "system_block";
  if (path === "$.instructions" && !Array.isArray(value)) return "system_block";
  if (/^\$\.instructions\[\d+\]$/.test(path)) return "system_block";
  if (/^\$\.(?:tools|additional_tools)\[\d+\]$/.test(path)) return "tool_schema";
  if (/^\$\.messages\[\d+\]$/.test(path)) return value?.role === "tool" ? "tool_result" : "message";
  if (path === "$.input" && !Array.isArray(value)) return "message";
  if (/^\$\.input\[\d+\]$/.test(path)) return responsesInputBlockKind(value);
  return null;
}

function responsesInputBlockKind(value) {
  const type = String(value?.type || "").toLowerCase();
  const role = String(value?.role || "").toLowerCase();
  if (role === "tool" || type.endsWith("_output") || type === "function_call_output") return "tool_result";
  return "message";
}

function isScalar(value) {
  return value === null || typeof value !== "object";
}

function escapePathKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}
