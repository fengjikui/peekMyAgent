import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  CODEBUDDY_MODEL_CONFIG_PATHS_ENV,
  CODEBUDDY_PROXY_MODEL_ENV,
  CODEBUDDY_PROXY_URL_ENV,
  buildCodeBuddyProxyEnv,
  codeBuddyModelConfigPaths,
  codeBuddyContinuesSession,
  codeBuddyConversationFromArgs,
  codeBuddyForksSession,
  codeBuddyModelFromArgs,
  inspectCodeBuddyConfiguration,
  replaceCodeBuddyContinueWithResume,
} from "../src/adapters/codebuddy-config.mjs";

const fakeOpenCode = () => ({
  model: "mimo/mimo-v2.5-pro",
  provider_id: "mimo",
  provider_npm: "@ai-sdk/openai-compatible",
  target_base_url: "https://provider.invalid/v1",
});

assert.deepEqual(inspectCodeBuddyConfiguration({ inspectOpenCode: fakeOpenCode }), {
  model: "mimo-v2.5-pro",
  provider_id: "mimo",
  target_base_url: "https://provider.invalid/v1",
  configuration_source: "opencode",
});

assert.deepEqual(
  inspectCodeBuddyConfiguration({
    targetBaseUrl: "https://explicit.invalid/api/v1/",
    model: "explicit-model",
    providerId: "explicit-provider",
    inspectOpenCode: () => {
      throw new Error("explicit configuration must not inspect OpenCode");
    },
  }),
  {
    model: "explicit-model",
    provider_id: "explicit-provider",
    target_base_url: "https://explicit.invalid/api/v1",
    configuration_source: "explicit",
  },
);

assert.equal(codeBuddyModelFromArgs(["--model", "mimo-v2.5"]), "mimo-v2.5");
assert.equal(codeBuddyModelFromArgs(["--model=mimo-v2.5-pro"]), "mimo-v2.5-pro");
assert.equal(codeBuddyConversationFromArgs(["--session-id", "session-one"]), "session-one");
assert.equal(codeBuddyConversationFromArgs(["-r", "session-two"]), "session-two");
assert.equal(codeBuddyContinuesSession(["-c"]), true);
assert.equal(codeBuddyContinuesSession(["--resume=session-three"]), true);
assert.equal(codeBuddyForksSession(["--continue", "--fork-session"]), true);
assert.deepEqual(
  replaceCodeBuddyContinueWithResume(["--print", "--continue", "continue this"], "session-four"),
  ["--resume", "session-four", "--print", "continue this"],
);

const originalEnv = {
  CODEBUDDY_API_KEY: "codebuddy-secret",
  CODEBUDDY_CONFIG_DIR: path.join(os.tmpdir(), "codebuddy-config-contract"),
  NODE_OPTIONS: "--trace-warnings",
  PRESERVED_VALUE: "preserved",
};
const workspace = path.join(os.tmpdir(), "codebuddy-workspace-contract");
const proxyEnv = buildCodeBuddyProxyEnv({
  env: originalEnv,
  proxyBaseUrl: "http://127.0.0.1:43111/watch/codebuddy",
  model: "mimo-v2.5-pro",
  cwd: workspace,
});
assert.equal(proxyEnv.CODEBUDDY_BASE_URL, "http://127.0.0.1:43111/watch/codebuddy");
assert.equal(proxyEnv.CODEBUDDY_API_KEY, "codebuddy-secret");
assert.equal(proxyEnv.CODEBUDDY_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.CODEBUDDY_SMALL_FAST_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.CODEBUDDY_BIG_SLOW_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.CODEBUDDY_CODE_SUBAGENT_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.PRESERVED_VALUE, "preserved");
assert.match(proxyEnv.NODE_OPTIONS, /^--trace-warnings --require=/);
assert.deepEqual(JSON.parse(proxyEnv[CODEBUDDY_MODEL_CONFIG_PATHS_ENV]), [
  path.join(originalEnv.CODEBUDDY_CONFIG_DIR, "models.json"),
  path.join(workspace, ".codebuddy", "models.json"),
]);
assert.equal(proxyEnv[CODEBUDDY_PROXY_MODEL_ENV], "mimo-v2.5-pro");
assert.equal(proxyEnv[CODEBUDDY_PROXY_URL_ENV], "http://127.0.0.1:43111/watch/codebuddy/chat/completions");
assert.equal(originalEnv.CODEBUDDY_BASE_URL, undefined, "parent env remains unchanged");

const fileCredentialEnv = buildCodeBuddyProxyEnv({
  env: { HOME: path.join(os.tmpdir(), "codebuddy-file-home") },
  cwd: workspace,
  proxyBaseUrl: "http://127.0.0.1:43111/watch/codebuddy",
  model: "mimo-v2.5-pro",
});
assert.equal(fileCredentialEnv.CODEBUDDY_API_KEY, undefined, "file-owned credentials do not move into PMA's environment");
assert.match(fileCredentialEnv.NODE_OPTIONS, /codebuddy-model-config-hook\.cjs/);
assert.deepEqual(codeBuddyModelConfigPaths({
  cwd: workspace,
  env: {
    HOME: path.join(os.tmpdir(), "ignored-home"),
    CODEBUDDY_CONFIG_DIR: path.join(os.tmpdir(), "ignored-codebuddy-config"),
    WORKBUDDY_CONFIG_DIR: path.join(os.tmpdir(), "workbuddy-config"),
  },
}), [
  path.join(os.tmpdir(), "workbuddy-config", "models.json"),
  path.join(workspace, ".codebuddy", "models.json"),
]);
assert.throws(
  () => inspectCodeBuddyConfiguration({ targetBaseUrl: "https://user:secret@example.invalid/v1", model: "m" }),
  /must not contain credentials/,
);
assert.throws(
  () => inspectCodeBuddyConfiguration({
    inspectOpenCode: () => ({ ...fakeOpenCode(), provider_npm: "@ai-sdk/anthropic" }),
  }),
  /has not been verified/,
);

console.log("codebuddy config contract smoke passed (OpenCode-derived model, explicit override, child-only route hook, file credential ownership, resume args)");
