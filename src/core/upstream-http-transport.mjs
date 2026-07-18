import http from "node:http";
import https from "node:https";

export function createUpstreamHttpTransport({ env = process.env } = {}) {
  const httpAgent = new http.Agent({ keepAlive: true, proxyEnv: env });
  const httpsAgent = new https.Agent({ keepAlive: true, proxyEnv: env });
  let closed = false;

  return {
    request(url, options, callback) {
      if (closed) throw new Error("Upstream HTTP transport is closed.");
      const parsed = url instanceof URL ? url : new URL(url);
      const client = parsed.protocol === "https:" ? https : http;
      const agent = parsed.protocol === "https:" ? httpsAgent : httpAgent;
      return client.request(parsed, { ...options, agent }, callback);
    },
    close() {
      if (closed) return;
      closed = true;
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
