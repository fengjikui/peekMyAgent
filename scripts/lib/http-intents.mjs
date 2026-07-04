const INTENT_HEADER = "x-peekmyagent-intent";

export function jsonHeadersForUrl(url, extraHeaders = {}) {
  return {
    "content-type": "application/json",
    ...intentHeadersForUrl(url),
    ...extraHeaders,
  };
}

export function intentHeadersForUrl(url) {
  switch (pathnameForUrl(url)) {
    case "/api/source/update":
      return { [INTENT_HEADER]: "source-update" };
    case "/api/watch/start":
      return { [INTENT_HEADER]: "watch-start" };
    case "/api/watch/stop":
      return { [INTENT_HEADER]: "watch-stop" };
    case "/api/watch/pause":
      return { [INTENT_HEADER]: "watch-pause" };
    default:
      return {};
  }
}

function pathnameForUrl(url) {
  try {
    return new URL(String(url), "http://127.0.0.1").pathname;
  } catch {
    return "";
  }
}
