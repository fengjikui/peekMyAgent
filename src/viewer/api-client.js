export class ViewerApiClient {
  constructor({ fetchImpl = globalThis.fetch, fetchContext = globalThis, origin = globalThis.location?.origin || "http://127.0.0.1" } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetchImpl is required");
    this.fetch = fetchImpl.bind(fetchContext);
    this.origin = origin;
  }

  listSources() {
    return this.getJson("/api/sources");
  }

  viewSource(sourceId, { initial = false, limit = 32 } = {}) {
    const url = new URL("/api/view", this.origin);
    url.searchParams.set("source", sourceId);
    url.searchParams.set("compact", "1");
    if (initial) {
      url.searchParams.set("initial", "1");
      url.searchParams.set("limit", String(limit));
    }
    return this.getJson(`${url.pathname}${url.search}`);
  }

  requestDetail(sourceId, requestId) {
    return this.getJson(`/api/request?source=${encodeURIComponent(sourceId)}&request=${encodeURIComponent(requestId)}`);
  }

  translations(agent, targetLanguage) {
    return this.getJson(
      `/api/translations?agent=${encodeURIComponent(agent)}&target_language=${encodeURIComponent(targetLanguage)}`,
    );
  }

  generateTranslations(payload) {
    return this.postJson("/api/translations/generate", "translation-generate", payload);
  }

  updateSource(payload) {
    return this.postJson("/api/source/update", "source-update", payload);
  }

  sendAgent(payload) {
    return this.postJson("/api/agent/send", "agent-send", payload);
  }

  stopWatch(payload) {
    return this.postJson("/api/watch/stop", "watch-stop", payload);
  }

  importTrace(body, fileName) {
    return this.getJson("/api/trace/import", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-peekmyagent-intent": "trace-import",
        "x-peekmyagent-file-name": fileName,
      },
      body,
    });
  }

  exportTrace(sourceId) {
    return this.getResponse(`/api/trace/export?source=${encodeURIComponent(sourceId)}`, {
      headers: { "x-peekmyagent-intent": "trace-export" },
    });
  }

  postJson(path, intent, payload) {
    return this.getJson(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-peekmyagent-intent": intent,
      },
      body: JSON.stringify(payload),
    });
  }

  async getJson(path, options = {}) {
    const response = await this.getResponse(path, options);
    return response.json();
  }

  async getResponse(path, options = {}) {
    const response = await this.fetch(path, options);
    if (!response.ok) throw new Error(await responseErrorMessage(response));
    return response;
  }
}

export async function responseErrorMessage(response) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed.error || text;
  } catch {
    return text;
  }
}
