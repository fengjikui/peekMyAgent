import { assertSourceSummary } from "../contracts/viewer-api.mjs";

export {
  SOURCE_SUMMARY_CONTRACT_VERSION,
  assertSourceSummary,
  validateSourceSummary,
} from "../contracts/viewer-api.mjs";

export class SourceRepository {
  constructor({ listBase, listPersisted, listImported, decorate, sanitizeId, notFoundError } = {}) {
    this.listBase = requiredFunction(listBase, "listBase");
    this.listPersisted = requiredFunction(listPersisted, "listPersisted");
    this.listImported = requiredFunction(listImported, "listImported");
    this.decorate = requiredFunction(decorate, "decorate");
    this.sanitizeId = requiredFunction(sanitizeId, "sanitizeId");
    this.notFoundError = typeof notFoundError === "function" ? notFoundError : (id) => new Error(`Source not found: ${id}`);
  }

  list({ includeStats = true } = {}) {
    const sources = [
      ...asSourceList(this.listBase({ includeStats }), "base"),
      ...asSourceList(this.listPersisted(), "persisted"),
      ...asSourceList(this.listImported(), "imported"),
    ];
    const decorated = asSourceList(this.decorate(sources), "decorated");
    for (const [index, source] of decorated.entries()) assertSourceSummary(source, `source[${index}]`);
    return decorated;
  }

  resolve(sourceId, { requireSource = false, sources = null } = {}) {
    const availableSources = sources || this.list();
    const requested = this.sanitizeId(sourceId);
    const source = requested ? availableSources.find((item) => item.id === requested) : null;
    if (source) return source;
    if (requireSource || requested) throw this.notFoundError(requested || "missing");
    const fallback = availableSources[0];
    if (!fallback) throw new Error("No viewer sources configured");
    return fallback;
  }
}

function asSourceList(value, provider) {
  if (!Array.isArray(value)) throw new Error(`${provider} source provider must return an array`);
  return value.filter(Boolean);
}

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} is required`);
  return value;
}
