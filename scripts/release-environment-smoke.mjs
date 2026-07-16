import assert from "node:assert/strict";
import {
  preserveReleaseCheckHostEnvironment,
  RELEASE_CHECK_HOST_ENV_KEYS,
  RELEASE_CHECK_HOST_ENV_PREFIX,
  RELEASE_CHECK_PROVIDER_ENV_KEYS,
  sanitizeReleaseCheckEnvironment,
} from "./lib/release-environment.mjs";
import {
  chromiumExecutableCandidates,
  chromiumSpawnEnvironment,
} from "./lib/chromium-cdp.mjs";

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

const preservedHostEnvironment = preserveReleaseCheckHostEnvironment({
  HOME: "C:\\Users\\runner",
  USERPROFILE: "C:\\Users\\runner",
  LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
  APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
});
for (const key of RELEASE_CHECK_HOST_ENV_KEYS) {
  assert.equal(
    preservedHostEnvironment[`${RELEASE_CHECK_HOST_ENV_PREFIX}${key}`],
    key === "HOME" || key === "USERPROFILE"
      ? "C:\\Users\\runner"
      : `C:\\Users\\runner\\AppData\\${key === "LOCALAPPDATA" ? "Local" : "Roaming"}`,
  );
}

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
    PEEKMYAGENT_RELEASE_HOST_HOME: "C:\\Users\\runner",
    PEEKMYAGENT_RELEASE_HOST_USERPROFILE: "C:\\Users\\runner",
    PEEKMYAGENT_RELEASE_HOST_LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
    PEEKMYAGENT_RELEASE_HOST_APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
  },
});
assert.equal(isolatedWindowsBrowserEnv.HOME, "C:\\Users\\runner");
assert.equal(isolatedWindowsBrowserEnv.USERPROFILE, "C:\\Users\\runner");
assert.equal(isolatedWindowsBrowserEnv.LOCALAPPDATA, "C:\\Users\\runner\\AppData\\Local");
assert.equal(isolatedWindowsBrowserEnv.APPDATA, "C:\\Users\\runner\\AppData\\Roaming");
for (const key of RELEASE_CHECK_HOST_ENV_KEYS) {
  assert.equal(
    Object.hasOwn(isolatedWindowsBrowserEnv, `${RELEASE_CHECK_HOST_ENV_PREFIX}${key}`),
    false,
    `browser subprocess must not retain the internal preserved ${key} variable`,
  );
}
assert.equal(isolatedWindowsBrowserEnv.PATH, "C:\\Windows\\System32");

const isolatedWindowsBrowserEnvWithoutHostPaths = chromiumSpawnEnvironment({
  platform: "win32",
  env: {
    HOME: "C:\\isolated\\home",
    USERPROFILE: "C:\\isolated\\profile",
    LOCALAPPDATA: "C:\\isolated\\local",
    APPDATA: "C:\\isolated\\roaming",
    PEEKMYAGENT_RELEASE_CHECK_ISOLATED: "1",
  },
});
for (const key of RELEASE_CHECK_HOST_ENV_KEYS) {
  assert.equal(
    Object.hasOwn(isolatedWindowsBrowserEnvWithoutHostPaths, key),
    false,
    `isolated Windows browser must remove fake ${key} when no host value was preserved`,
  );
}

const windowsBrowserCandidates = chromiumExecutableCandidates({
  platform: "win32",
  env: {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  },
});
assert.match(windowsBrowserCandidates[0], /Microsoft[\\/]Edge[\\/]Application[\\/]msedge\.exe$/);
assert.ok(
  windowsBrowserCandidates.findIndex((candidate) => /Microsoft[\\/]Edge/.test(candidate)) <
    windowsBrowserCandidates.findIndex((candidate) => /Google[\\/]Chrome/.test(candidate)),
  "Windows browser discovery must prefer Edge before branded Chrome for isolated CDP checks",
);

console.log("release environment smoke passed");
