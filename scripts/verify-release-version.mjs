import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const version = String(packageJson.version || "");
const tag = optionValue("--tag") || process.env.GITHUB_REF_NAME || "";

if (!isSemver(version) || version === "0.0.0") {
  fail(`package.json must use a publishable semantic version, received ${JSON.stringify(version)}`);
}
if (lock.version !== version || lock.packages?.[""]?.version !== version) {
  fail(`package-lock.json version does not match package.json ${version}`);
}
if (packageJson.publishConfig?.access !== "public") {
  fail("package.json publishConfig.access must be public");
}
if (!new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  fail(`CHANGELOG.md is missing a dated [${version}] release section`);
}
if (tag && tag !== `v${version}`) {
  fail(`release tag ${JSON.stringify(tag)} does not match package version v${version}`);
}

console.log(`release version verified: v${version}${tag ? ` (${tag})` : ""}`);

function optionValue(name) {
  const assignment = process.argv.slice(2).find((value) => value.startsWith(`${name}=`));
  if (assignment) return assignment.slice(`${name}=`.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  console.error(`peekMyAgent release version error: ${message}`);
  process.exit(1);
}
