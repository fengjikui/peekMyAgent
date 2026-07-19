import { zstdDecompressSync } from "node:zlib";

export const CODEX_CAPTURE_ADAPTER = "codex_responses_v1";
export const CODEX_CHATGPT_ORIGIN = "https://chatgpt.com";
export const CODEX_CAPTURE_PROVIDER_ID = "peekmyagent_http";
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const ROUTES = new Map([
  ["GET /v1/models", { upstreamPath: "/backend-api/codex/models", capture: false }],
  ["POST /v1/responses", { upstreamPath: "/backend-api/codex/responses", capture: true }],
  ["POST /v1/responses/compact", { upstreamPath: "/backend-api/codex/responses/compact", capture: true }],
  ["POST /v1/alpha/search", { upstreamPath: "/backend-api/codex/alpha/search", capture: true }],
]);

export function createCodexExactProxyAdapter({ maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES } = {}) {
  return {
    id: CODEX_CAPTURE_ADAPTER,
    resolveRequest({ method, forwardPath }) {
      const parsed = new URL(forwardPath || "/", "http://peek.local");
      const normalizedMethod = String(method || "GET").toUpperCase();
      const route = ROUTES.get(`${normalizedMethod} ${parsed.pathname}`);
      if (!route) {
        throw proxyError(
          404,
          `Codex capture does not forward ${normalizedMethod} ${parsed.pathname}. Only verified first-party Codex routes are allowed.`,
        );
      }
      return {
        ...route,
        originalPath: `${parsed.pathname}${parsed.search}`,
        forwardPath: `${route.upstreamPath}${parsed.search}`,
      };
    },
    decodeRequest({ bodyBuffer, headers }) {
      const raw = Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer || "");
      const contentEncoding = normalizedContentEncoding(headers?.["content-encoding"]);
      let decoded = raw;
      if (contentEncoding === "zstd") {
        try {
          decoded = zstdDecompressSync(raw, { maxOutputLength: maxDecodedBytes });
        } catch (error) {
          throw proxyError(400, `Codex zstd request could not be decoded safely: ${error.message}`);
        }
      } else if (contentEncoding !== "identity") {
        throw proxyError(415, `Unsupported Codex request content-encoding: ${contentEncoding}`);
      }
      if (decoded.length > maxDecodedBytes) {
        throw proxyError(413, `Decoded Codex request exceeds the ${formatBytes(maxDecodedBytes)} safety limit.`);
      }
      const bodyText = decoded.toString("utf8");
      return {
        bodyText,
        bodyJson: parseJson(bodyText),
        rawBodyLength: raw.length,
        decodedBodyLength: decoded.length,
        contentEncoding,
      };
    },
  };
}

export function codexOpenAiBaseUrl(watchBaseUrl) {
  return `${String(watchBaseUrl || "").replace(/\/$/, "")}/v1`;
}

export function codexHttpProviderOverrides(watchBaseUrl) {
  return [
    "-c",
    `model_provider=${JSON.stringify(CODEX_CAPTURE_PROVIDER_ID)}`,
    ...codexHttpProviderDefinitionOverrides(watchBaseUrl),
  ];
}

export function codexHttpProviderDefinitionOverrides(watchBaseUrl) {
  const definition = codexHttpProviderDefinition(watchBaseUrl);
  const provider = `model_providers.${CODEX_CAPTURE_PROVIDER_ID}`;
  return [
    "-c",
    `${provider}.name=${JSON.stringify(definition.name)}`,
    "-c",
    `${provider}.base_url=${JSON.stringify(definition.base_url)}`,
    "-c",
    `${provider}.wire_api=${JSON.stringify(definition.wire_api)}`,
    "-c",
    `${provider}.requires_openai_auth=${definition.requires_openai_auth}`,
    "-c",
    `${provider}.supports_websockets=${definition.supports_websockets}`,
  ];
}

export function codexHttpProviderDefinition(watchBaseUrl) {
  return {
    name: "peekMyAgent HTTP capture",
    base_url: codexOpenAiBaseUrl(watchBaseUrl),
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
  };
}

function normalizedContentEncoding(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const encoding = String(raw || "identity").trim().toLowerCase();
  return encoding || "identity";
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function proxyError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
