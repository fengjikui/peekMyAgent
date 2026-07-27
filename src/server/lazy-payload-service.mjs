import crypto from "node:crypto";
import { LAZY_PAYLOAD_MARKER, assertLazyPayloadResponse } from "../contracts/lazy-payload.mjs";

export const LAZY_PAYLOAD_LIMITS = Object.freeze({
  refChars: 2048,
  toolResultTextChars: 4096,
  imageBase64Chars: 64,
});

const SAFE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "function_call_output", "custom_tool_call_output"]);

export function projectLazyPayloads(detail) {
  return projectValue(detail, [], []).value;
}

export function loadLazyPayload(detail, ref) {
  const path = decodePayloadRef(ref);
  const located = valueAtPath(detail, path);
  if (!located.found || typeof located.value !== "string") throw lazyPayloadError(404, "Lazy payload not found");
  const descriptor = describeLazyPayload(located.value, path, located.ancestors);
  if (!descriptor || encodePayloadRef(path) !== ref) throw lazyPayloadError(404, "Lazy payload not found");
  return assertLazyPayloadResponse({
    request_id: String(detail?.request?.id || ""),
    ref,
    payload: {
      kind: descriptor.kind,
      encoding: descriptor.encoding,
      mime_type: descriptor.mime_type,
      byte_size: descriptor.byte_size,
      sha256: descriptor.sha256,
      value: located.value,
    },
  });
}

function projectValue(value, path, ancestors) {
  if (typeof value === "string") {
    const descriptor = describeLazyPayload(value, path, ancestors);
    return descriptor
      ? {
          value: {
            __peekmyagent_lazy_payload__: LAZY_PAYLOAD_MARKER,
            ref: encodePayloadRef(path),
            ...descriptor,
          },
          changed: true,
        }
      : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const projected = projectValue(item, [...path, index], [...ancestors, value]);
      changed ||= projected.changed;
      return projected.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const entries = Object.entries(value).map(([key, item]) => {
    const projected = projectValue(item, [...path, key], [...ancestors, value]);
    changed ||= projected.changed;
    return [key, projected.value];
  });
  return { value: changed ? Object.fromEntries(entries) : value, changed };
}

function describeLazyPayload(value, path, ancestors) {
  if (!isRawPayloadPath(path)) return null;
  const image = imagePayloadDescriptor(value, path, ancestors);
  if (image) return image;
  if (value.length < LAZY_PAYLOAD_LIMITS.toolResultTextChars || !hasToolResultAncestor(ancestors)) return null;
  const byteSize = Buffer.byteLength(value, "utf8");
  return {
    kind: looksLikeJson(value) ? "json" : "text",
    encoding: "utf8",
    mime_type: looksLikeJson(value) ? "application/json" : "text/plain",
    byte_size: byteSize,
    char_count: value.length,
    token_estimate: Math.ceil(value.length / 4),
    sha256: sha256(Buffer.from(value, "utf8")),
  };
}

function imagePayloadDescriptor(value, path, ancestors) {
  const dataUrl = parseImageDataUrl(value);
  if (dataUrl) return imageDescriptor(dataUrl.bytes, dataUrl.mimeType, "data_url", value.length);
  const key = String(path.at(-1) || "").toLowerCase();
  const mimeType = imageMimeTypeFromAncestors(ancestors);
  if (
    !mimeType ||
    !["data", "image", "image_data", "base64"].includes(key) ||
    value.length < LAZY_PAYLOAD_LIMITS.imageBase64Chars ||
    !looksLikeBase64(value)
  ) {
    return null;
  }
  let bytes;
  try {
    bytes = Buffer.from(value.replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  return imageDescriptor(bytes, mimeType, "base64", value.length);
}

function imageDescriptor(bytes, mimeType, encoding, encodedChars) {
  const dimensions = imageDimensions(bytes, mimeType);
  return {
    kind: "image",
    encoding,
    mime_type: mimeType,
    byte_size: bytes.length,
    encoded_chars: encodedChars,
    sha256: sha256(bytes),
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
  };
}

function parseImageDataUrl(value) {
  const match = String(value).match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  if (!SAFE_IMAGE_MIME_TYPES.has(mimeType)) return null;
  try {
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    return bytes.length ? { mimeType, bytes } : null;
  } catch {
    return null;
  }
}

function imageMimeTypeFromAncestors(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const value = ancestors[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const key of ["media_type", "mime_type", "content_type", "mimeType"]) {
      const candidate = String(value[key] || "").toLowerCase();
      if (SAFE_IMAGE_MIME_TYPES.has(candidate)) return candidate;
    }
  }
  return null;
}

function hasToolResultAncestor(ancestors) {
  return ancestors.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const role = String(value.role || "").toLowerCase();
    const type = String(value.type || "").toLowerCase();
    return role === "tool" || TOOL_RESULT_TYPES.has(type) || type.endsWith("_output");
  });
}

function isRawPayloadPath(path) {
  return path[0] === "request" && path[1] === "raw" && (path[2] === "body" || path[2] === "response");
}

function looksLikeJson(value) {
  const text = String(value).trim();
  if (!text || !["{", "["].includes(text[0])) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function looksLikeBase64(value) {
  const compact = String(value).replace(/\s+/g, "");
  return compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function imageDimensions(bytes, mimeType) {
  if (mimeType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  return null;
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += length + 2;
  }
  return null;
}

function encodePayloadRef(path) {
  return Buffer.from(JSON.stringify(path), "utf8").toString("base64url");
}

function decodePayloadRef(ref) {
  const text = String(ref || "");
  if (!text || text.length > LAZY_PAYLOAD_LIMITS.refChars || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw lazyPayloadError(400, "Invalid lazy payload ref");
  }
  let path;
  try {
    path = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw lazyPayloadError(400, "Invalid lazy payload ref");
  }
  if (!Array.isArray(path) || !path.length || path.length > 64 || path.some((part) => !validPathPart(part))) {
    throw lazyPayloadError(400, "Invalid lazy payload ref");
  }
  return path;
}

function validPathPart(value) {
  return (typeof value === "string" && value.length > 0 && value.length <= 256) || (Number.isSafeInteger(value) && value >= 0);
}

function valueAtPath(root, path) {
  let value = root;
  const ancestors = [];
  for (const part of path) {
    if (value == null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { found: false, value: null, ancestors };
    }
    ancestors.push(value);
    value = value[part];
  }
  return { found: true, value, ancestors };
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function lazyPayloadError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
