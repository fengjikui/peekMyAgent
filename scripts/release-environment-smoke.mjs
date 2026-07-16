import assert from "node:assert/strict";
import {
  RELEASE_CHECK_PROVIDER_ENV_KEYS,
  sanitizeReleaseCheckEnvironment,
} from "./lib/release-environment.mjs";
import { chromiumSpawnEnvironment } from "./lib/chromium-cdp.mjs";

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

const isolatedMacBrowserEnv = chromiumSpawnEnvironment({
  env: { HOME: "/isolated/home", USERPROFILE: "/isolated/profile", PEEKMYAGENT_RELEASE_CHECK_ISOLATED: "1" },
  platform: "darwin",
});
assert.equal(Object.hasOwn(isolatedMacBrowserEnv, "HOME"), false);
assert.equal(Object.hasOwn(isolatedMacBrowserEnv, "USERPROFILE"), false);
assert.equal(
  chromiumSpawnEnvironment({ env: { HOME: "/normal/home" }, platform: "darwin" }).HOME,
  "/normal/home",
  "ordinary browser smokes must preserve the caller environment",
);
assert.equal(
  chromiumSpawnEnvironment({
    env: { HOME: "/isolated/linux", PEEKMYAGENT_RELEASE_CHECK_ISOLATED: "1" },
    platform: "linux",
  }).HOME,
  "/isolated/linux",
  "only macOS Chromium requires the system-account HOME fallback",
);

const isolatedWindowsBrowserEnv = chromiumSpawnEnvironment({
  platform: "win32",
  env: {
    HOME: "C:\\isolated\\home",
    USERPROFILE: "C:\\isolated\\profile",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
    APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
    PATH: "C:\\Windows\\System32",
    PEEKMYAGENT_RELEASE_CHECK_ISOLATED: "1",
  },
});
for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) {
  assert.equal(Object.hasOwn(isolatedWindowsBrowserEnv, key), false, `isolated Windows browser must remove ${key}`);
}
assert.equal(isolatedWindowsBrowserEnv.PATH, "C:\\Windows\\System32");

console.log("release environment smoke passed");
