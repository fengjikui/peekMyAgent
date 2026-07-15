import assert from "node:assert/strict";
import {
  RELEASE_CHECK_PROVIDER_ENV_KEYS,
  sanitizeReleaseCheckEnvironment,
} from "./lib/release-environment.mjs";

const original = {
  PATH: "/test/bin",
  HOME: "/test/home",
  ANTHROPIC_AUTH_TOKEN: "real-anthropic-secret",
  DEEPSEEK_API_KEY: "real-deepseek-secret",
  OPENAI_BASE_URL: "https://provider.example/v1",
  PEEKMYAGENT_TRANSLATION_MODEL: "real-provider-model",
};
const sanitized = sanitizeReleaseCheckEnvironment(original);

assert.equal(sanitized.PATH, original.PATH);
assert.equal(sanitized.HOME, original.HOME);
for (const key of RELEASE_CHECK_PROVIDER_ENV_KEYS) {
  assert.equal(Object.hasOwn(sanitized, key), false, `release check must remove ${key}`);
}
assert.equal(original.DEEPSEEK_API_KEY, "real-deepseek-secret", "sanitization must not mutate the caller environment");

console.log("release environment smoke passed");
