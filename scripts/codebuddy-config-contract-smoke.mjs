import assert from "node:assert/strict";
import {
  buildCodeBuddyProxyEnv,
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
  PRESERVED_VALUE: "preserved",
};
const proxyEnv = buildCodeBuddyProxyEnv({
  env: originalEnv,
  proxyBaseUrl: "http://127.0.0.1:43111/watch/codebuddy",
  model: "mimo-v2.5-pro",
});
assert.equal(proxyEnv.CODEBUDDY_BASE_URL, "http://127.0.0.1:43111/watch/codebuddy");
assert.equal(proxyEnv.CODEBUDDY_API_KEY, "codebuddy-secret");
assert.equal(proxyEnv.CODEBUDDY_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.CODEBUDDY_SMALL_FAST_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.CODEBUDDY_BIG_SLOW_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.CODEBUDDY_CODE_SUBAGENT_MODEL, "mimo-v2.5-pro");
assert.equal(proxyEnv.PRESERVED_VALUE, "preserved");
assert.equal(originalEnv.CODEBUDDY_BASE_URL, undefined, "parent env remains unchanged");

assert.throws(
  () => buildCodeBuddyProxyEnv({ env: {}, proxyBaseUrl: "http://127.0.0.1:43111/watch/codebuddy", model: "mimo-v2.5-pro" }),
  /Missing CODEBUDDY_API_KEY/,
);
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

console.log("codebuddy config contract smoke passed (OpenCode-derived model, explicit override, child-only env, auth boundary, resume args)");
