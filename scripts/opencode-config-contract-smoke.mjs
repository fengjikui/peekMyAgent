#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildOpenCodeProxyEnv,
  inspectOpenCodeConfiguration,
  openCodeModelFromArgs,
  openCodeSessionFromArgs,
  parseInlineConfig,
  providerFromOpenCodeModel,
} from "../src/adapters/opencode-config.mjs";

const effectiveConfig = {
  model: "mimo/mimo-v2.5-pro",
  provider: {
    mimo: {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://provider.example/v1/",
        apiKey: "must-not-leak",
      },
      models: {
        "mimo-v2.5-pro": {},
      },
    },
  },
};

const inspected = inspectOpenCodeConfiguration({
  args: ["--session", "ses-123"],
  runDebugConfig: () => effectiveConfig,
});
assert.deepEqual(inspected, {
  model: "mimo/mimo-v2.5-pro",
  provider_id: "mimo",
  target_base_url: "https://provider.example/v1",
  provider_npm: "@ai-sdk/openai-compatible",
  conversation_id: "ses-123",
});
assert.doesNotMatch(JSON.stringify(inspected), /must-not-leak/);

const commandLineModel = inspectOpenCodeConfiguration({
  args: ["run", "--model=custom/fast", "-s", "ses-456"],
  runDebugConfig: () => ({
    ...effectiveConfig,
    provider: {
      ...effectiveConfig.provider,
      custom: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseUrl: "https://custom.example/api" },
      },
    },
  }),
});
assert.equal(commandLineModel.model, "custom/fast");
assert.equal(commandLineModel.provider_id, "custom");
assert.equal(commandLineModel.target_base_url, "https://custom.example/api");
assert.equal(commandLineModel.conversation_id, "ses-456");

const existingInlineConfig = {
  model: "mimo/mimo-v2.5-pro",
  plugin: ["local-plugin"],
  provider: {
    mimo: {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: "https://provider.example/v1",
        apiKey: "process-local-secret",
        headers: { "x-provider-feature": "enabled" },
      },
    },
  },
};
const childEnv = buildOpenCodeProxyEnv({
  env: {
    HOME: "/tmp/test-home",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(existingInlineConfig),
  },
  providerId: "mimo",
  proxyBaseUrl: "http://127.0.0.1:43111/watch/opencode-test/",
});
const childConfig = JSON.parse(childEnv.OPENCODE_CONFIG_CONTENT);
assert.equal(childConfig.model, existingInlineConfig.model);
assert.deepEqual(childConfig.plugin, ["local-plugin"]);
assert.equal(childConfig.provider.mimo.npm, "@ai-sdk/openai-compatible");
assert.equal(childConfig.provider.mimo.options.baseURL, "http://127.0.0.1:43111/watch/opencode-test");
assert.equal(childConfig.provider.mimo.options.apiKey, "process-local-secret");
assert.deepEqual(childConfig.provider.mimo.options.headers, { "x-provider-feature": "enabled" });

assert.equal(openCodeModelFromArgs(["run", "-m", "a/b"]), "a/b");
assert.equal(openCodeModelFromArgs(["--model=a/b"]), "a/b");
assert.equal(openCodeSessionFromArgs(["run", "-s", "session-a"]), "session-a");
assert.equal(openCodeSessionFromArgs(["--session=session-b"]), "session-b");
assert.equal(providerFromOpenCodeModel("provider/model"), "provider");
assert.deepEqual(parseInlineConfig(""), {});

assert.throws(() => providerFromOpenCodeModel("model-only"), /Expected provider\/model/);
assert.throws(() => parseInlineConfig("not-json"), /contains invalid JSON/);
assert.throws(
  () =>
    inspectOpenCodeConfiguration({
      runDebugConfig: () => ({ model: "mimo/missing", provider: {} }),
    }),
  /Could not resolve OpenCode provider/,
);
assert.throws(
  () =>
    inspectOpenCodeConfiguration({
      runDebugConfig: () => ({
        model: "mimo/missing-url",
        provider: { mimo: { options: { apiKey: "hidden" } } },
      }),
    }),
  /does not expose an explicit baseURL/,
);

console.log("opencode config contract smoke passed");
