export function normalizeRawSearchQuery(value) {
  return String(value || "").trim();
}

export function collectRawSearchEntries(value, rootPath, options = {}) {
  const serialize = options.serialize || defaultSerialize;
  const preview = options.preview || defaultPreview;
  const shallowLimit = Number(options.shallowLimit || 320);
  const output = [];

  visit(value, rootPath, output, { serialize, preview, shallowLimit });
  return output;
}

export function filterRawSearchEntries(entries, query) {
  const normalized = normalizeRawSearchQuery(query).toLowerCase();
  if (!normalized) return [];
  return (entries || []).filter((entry) => String(entry?.searchText || "").toLowerCase().includes(normalized));
}

export function rawSearchSnippetSegments(text, query, { before = 90, after = 180 } = {}) {
  const source = String(text || "");
  const needle = normalizeRawSearchQuery(query);
  if (!needle) return [{ text: source, match: false }];

  const index = source.toLowerCase().indexOf(needle.toLowerCase());
  const start = Math.max(0, index - before);
  const end = Math.min(source.length, (index < 0 ? 0 : index) + needle.length + after);
  const snippet = `${start > 0 ? "..." : ""}${source.slice(start, end)}${end < source.length ? "..." : ""}`;
  return splitCaseInsensitive(snippet, needle);
}

export function clampRawSearchIndex(index, count) {
  const size = Math.max(0, Number(count) || 0);
  if (!size) return 0;
  return Math.min(Math.max(0, Number(index) || 0), size - 1);
}

export function nextRawSearchIndex(index, delta, count) {
  const size = Math.max(0, Number(count) || 0);
  if (!size) return 0;
  return (clampRawSearchIndex(index, size) + Number(delta || 0) + size) % size;
}

export function escapeRawSearchRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visit(value, path, output, options) {
  if (value == null) {
    output.push(createEntry(path, String(value), String(value), options.preview));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`, output, options));
    return;
  }
  if (typeof value === "object") {
    const shallow = options.serialize(value);
    if (shallow.length <= options.shallowLimit) output.push(createEntry(path, shallow, shallow, options.preview));
    Object.keys(value).forEach((key) => visit(value[key], `${path}.${key}`, output, options));
    return;
  }
  const text = String(value);
  output.push(createEntry(path, text, text, options.preview));
}

function createEntry(path, text, value, preview) {
  return {
    path,
    scope: String(path || "").split(/[.[\]]/).filter(Boolean)[0] || path,
    text: preview(String(text || ""), 420),
    value: String(value || ""),
    searchText: `${path}\n${value}`,
  };
}

function splitCaseInsensitive(text, needle) {
  const output = [];
  const matcher = new RegExp(escapeRawSearchRegExp(needle), "gi");
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index || 0;
    if (index > cursor) output.push({ text: text.slice(cursor, index), match: false });
    output.push({ text: match[0], match: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) output.push({ text: text.slice(cursor), match: false });
  return output.length ? output : [{ text, match: false }];
}

function defaultSerialize(value) {
  return JSON.stringify(value);
}

function defaultPreview(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
